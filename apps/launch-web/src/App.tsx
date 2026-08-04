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
  type LaunchNavigate,
  resolveLaunchNavigationTarget,
} from "./lib/navigation";
import {
  shouldUseAgentStudioRoute,
  shouldUseNebulaRoute,
} from "./lib/nebula-route";
import {
  AccountFoundationPage,
  AdminFoundationPage,
  AgentFoundationPage,
  HomeFoundationPage,
  LibraryFoundationPage,
  PrivacyPage,
  StoreFoundationPage,
  TermsPage,
} from "./pages/foundation-pages";
import { LaunchShell, Wordmark } from "./components/launch-chrome";
import {
  NebulaFleetApp,
  NebulaSessionRestoringShell,
} from "./components/nebula-fleet";
import { DeviceLoginPage } from "./components/device-login";
import { FunnelPairingPage } from "./components/funnel-pairing";
import { PreAuthFleetHome } from "./components/pre-auth-fleet";
import { AgentStudioApp } from "./components/agent-studio/agent-studio";
import {
  SignInModalProvider,
  useSignInModal,
} from "./components/sign-in-modal";
import { ConnectTutorialPanel } from "./components/connect-tutorial";
import { AuthFunnelApp } from "./components/auth-funnel";
import { parseConnectTutorialContext } from "./lib/connect-tutorial";
import {
  establishLaunchConfirmationSession,
  establishLaunchMagicLinkSession,
  exchangeLaunchBridgeToken,
  getLaunchAuthToken,
  isLaunchAuthSessionStorageChange,
  isLaunchRefreshAvailable,
  LAUNCH_AUTH_SESSION_CHANGED_EVENT,
  launchAuthSessionIdentity,
  normalizeLocalPath,
  recordLaunchAuthDiagnostic,
  refreshLaunchSession,
  resolveMagicLinkNextPath,
} from "./lib/auth";
import { consumeExternalReturnRevalidation } from "./lib/external-navigation";

export interface LocationState {
  pathname: string;
  search: string;
}

export interface LaunchPageProps {
  live: LaunchRouteLiveState;
  location: LocationState;
  route: ResolvedLaunchRoute;
  navigate: LaunchNavigate;
}

const routeTitles: Record<LaunchRouteKey, string> = {
  home: "Home",
  connect: "Connect AI",
  library: "Agents",
  store: "Browse",
  agent: "Agent",
  pairing: "Watch your agent build",
  device: "Link your terminal",
  settings: "Profile",
  adminAgent: "Agent admin",
  authCallback: "Signing in",
  authConfirm: "Confirm sign in",
  terms: "Terms of Service",
  privacy: "Privacy Policy",
};

export function App(): ReactElement {
  const [location, setLocation] = useState<LocationState>(() =>
    currentLocation()
  );
  const [sessionRestoreFailed, setSessionRestoreFailed] = useState(false);
  const [authSession, setAuthSession] = useState(() => ({
    revision: 0,
    token: getLaunchAuthToken(),
  }));
  const authToken = authSession.token;
  const authSessionIdentity = useMemo(
    () => launchAuthSessionIdentity(authToken),
    [authToken],
  );
  const sessionRestoring = !authToken && isLaunchRefreshAvailable() &&
    !sessionRestoreFailed;

  useEffect(() => {
    const onPopState = () => setLocation(currentLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const synchronizeAuthSession = () => {
      const token = getLaunchAuthToken();
      setAuthSession((current) =>
        current.token === token
          ? current
          : { revision: current.revision + 1, token }
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (isLaunchAuthSessionStorageChange(event.key)) {
        synchronizeAuthSession();
      }
    };

    window.addEventListener(
      LAUNCH_AUTH_SESSION_CHANGED_EVENT,
      synchronizeAuthSession,
    );
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(
        LAUNCH_AUTH_SESSION_CHANGED_EVENT,
        synchronizeAuthSession,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // External flows such as Stripe can restore this page from the browser's
  // back-forward cache, including the exact DOM and JavaScript bundle that was
  // active before leaving. Reload that frozen snapshot so Back always resumes
  // the current launch UI and revalidates its data.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      const externalReturn = consumeExternalReturnRevalidation();
      if (event.persisted || externalReturn) {
        window.location.reload();
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // The access token only lives ~1h, while the API may retain an HttpOnly
  // refresh cookie. Revalidate on initial load and whenever a render observes
  // an expired token; the UI uses a stateless Nebula loading shell meanwhile.
  useEffect(() => {
    if (authToken) {
      if (sessionRestoreFailed) setSessionRestoreFailed(false);
      return;
    }
    if (!sessionRestoring) return;
    let cancelled = false;
    refreshLaunchSession()
      .then((token) => {
        if (cancelled) return;
        setSessionRestoreFailed(!token);
        setLocation(currentLocation());
      })
      .catch(() => {
        if (cancelled) return;
        setSessionRestoreFailed(true);
        setLocation(currentLocation());
      });
    return () => {
      cancelled = true;
    };
  }, [authToken, sessionRestoreFailed, sessionRestoring]);

  const navigate = useCallback<LaunchNavigate>((to, options = {}) => {
    const next = resolveLaunchNavigationTarget(to, window.location.href);
    if (next.origin !== window.location.origin) {
      window.location.href = next.href;
      return;
    }
    const method = options.replace ? "replaceState" : "pushState";
    window.history[method](null, "", `${next.pathname}${next.search}`);
    setLocation(currentLocation());
    if (options.scroll !== "preserve") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const route = useMemo(
    () => resolveLaunchRoute(location.pathname),
    [location.pathname],
  );
  const live = useLaunchRouteLiveData(location, route, {
    sessionIdentity: authSessionIdentity,
    sessionRevision: authSession.revision,
    suspend: sessionRestoring,
  });

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

  // The device-login page legitimately carries ?code= (the user code the
  // terminal printed) — it is not an OAuth authorization code.
  const providerCodeMisrouted = route.definition.key !== "authCallback" &&
    route.definition.key !== "device" &&
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

  const preAuthHome = !authToken && !sessionRestoring &&
    route.definition.key === "home" && !providerCodeMisrouted;
  const authFunnelRoute = route.definition.key === "connect" &&
    parseConnectTutorialContext(location.search).intent === "agent";

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

  const agentSummary = live.data.agent?.agent ?? live.data.agent?.tool;
  const routeDecision = {
    agentRelationship: sessionRestoring
      ? undefined
      : agentSummary?.relationship,
    authenticated: Boolean(authToken),
    loadStatus: live.status,
    routeKey: route.definition.key,
    sessionRestoring,
  } as const;
  const nebulaRoute = shouldUseNebulaRoute(routeDecision);
  const agentStudioRoute = shouldUseAgentStudioRoute(routeDecision);
  return (
    // Remount the application surface when the authenticated owner changes so
    // component-local alert/search/settings state cannot outlive its account.
    <SignInModalProvider key={authSessionIdentity}>
      {preAuthHome
        ? <PreAuthFleetHome navigate={navigate} />
        : authFunnelRoute && !providerCodeMisrouted
        ? (
          <AuthFunnelApp
            location={location}
            navigate={navigate}
            signedIn={Boolean(authToken)}
          />
        )
        : route.definition.key === "pairing"
        ? (
          <FunnelPairingPage
            code={route.params.code ?? ""}
            navigate={navigate}
          />
        )
        : route.definition.key === "device"
        ? (
          <DeviceLoginPage
            initialCode={new URLSearchParams(location.search).get("code") ??
              undefined}
            navigate={navigate}
          />
        )
        : route.definition.key === "authConfirm"
        ? <MagicLinkConfirmationPage location={location} />
        : route.definition.key === "authCallback" && !providerCodeMisrouted
        ? <AuthCallbackPage location={location} />
        : nebulaRoute && !providerCodeMisrouted
        ? sessionRestoring &&
            route.definition.key !== "connect"
          ? (
            <NebulaSessionRestoringShell
              agentOpen={route.definition.key === "agent"}
            />
          )
          : agentStudioRoute
          ? (
            <AgentStudioApp
              key={route.params.slug}
              live={live}
              location={location}
              route={route}
              navigate={navigate}
            />
          )
          : (
            <NebulaFleetApp
              live={live}
              location={location}
              route={route}
              navigate={navigate}
            />
          )
        : (
          <LaunchShell
            accountRoutes={accountRoutes()}
            activeRoute={activeSection}
            navigate={navigate}
            primaryRoutes={primaryRoutes()}
            title={routeTitles[route.definition.key]}
          >
            {providerCodeMisrouted
              ? <MisroutedAuthCallbackPage />
              : (
                <RouteSwitch
                  live={live}
                  location={location}
                  route={route}
                  navigate={navigate}
                />
              )}
          </LaunchShell>
        )}
    </SignInModalProvider>
  );
}

function RouteSwitch(
  { live, location, route, navigate }: LaunchPageProps,
): ReactElement {
  const openSignIn = useSignInModal();
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
    // The pairing watch page renders standalone before this switch; this arm
    // only satisfies exhaustiveness for direct hits.
    case "pairing":
      return (
        <FunnelPairingPage
          code={route.params.code ?? ""}
          navigate={navigate}
        />
      );
    case "device":
      return (
        <DeviceLoginPage
          initialCode={new URLSearchParams(location.search).get("code") ??
            undefined}
          navigate={navigate}
        />
      );
    case "connect": {
      const context = parseConnectTutorialContext(location.search);
      const agent = context.agentSlug
        ? live.data.fleet?.agents.find((item) =>
          item.agent.slug === context.agentSlug ||
          item.agent.id === context.agentSlug
        )?.agent ?? null
        : null;
      return (
        <ConnectTutorialPanel
          agent={agent}
          dataReady={live.status === "ready" || live.status === "error"}
          location={location}
          onSignIn={openSignIn}
          signedIn={Boolean(getLaunchAuthToken())}
        />
      );
    }
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
    case "authConfirm":
      return <MagicLinkConfirmationPage location={location} />;
    case "terms":
      return <TermsPage />;
    case "privacy":
      return <PrivacyPage />;
  }
}

export function MagicLinkConfirmationPage(
  { location }: { location: LocationState },
): ReactElement {
  const query = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const tokenHash = query.get("token_hash");
  const tokenType = query.get("type");
  const nextPath = resolveMagicLinkNextPath(query.get("next"));
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    !tokenHash || (tokenType && tokenType !== "email")
      ? "This sign-in link is incomplete. Request a new link to continue."
      : null
  );

  const confirmSignIn = async () => {
    if (!tokenHash || verifying) return;
    setVerifying(true);
    setError(null);
    try {
      await establishLaunchMagicLinkSession(tokenHash);
      window.location.replace(nextPath);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to confirm this sign-in link.",
      );
      setVerifying(false);
    }
  };

  return (
    <main className="auth-confirm-page">
      <section className="auth-confirm-panel">
        <Wordmark />
        <div className="signin-mail-icon" aria-hidden="true">
          <MailCheckIcon />
        </div>
        <div className="auth-confirm-copy">
          <p className="section-label">Email sign in</p>
          <h1>Continue to Galactic</h1>
          <p>
            Press continue to confirm this email sign-in. This extra click keeps
            automated email scanners from using your one-time link.
          </p>
        </div>
        {error
          ? (
            <p className="signin-error auth-confirm-error" role="alert">
              {error}
            </p>
          )
          : null}
        <button
          className="signin-submit"
          disabled={verifying || !tokenHash}
          onClick={confirmSignIn}
          type="button"
        >
          {verifying
            ? (
              <>
                <span className="signin-spinner" aria-hidden="true" />
                Confirming…
              </>
            )
            : "Continue to Galactic"}
        </button>
        {error
          ? (
            <a className="auth-confirm-home" href="/">
              Return to Galactic
            </a>
          )
          : null}
      </section>
    </main>
  );
}

export function AuthCallbackPage(
  { location }: { location: LocationState },
): ReactElement {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const query = new URLSearchParams(location.search);
    const bridgeToken = hash.get("bridge_token");
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    const expiresIn = hash.get("expires_in");
    const nextPath = normalizeLocalPath(query.get("next"));
    const refreshHandoff = query.get("session") === "refresh";
    recordLaunchAuthDiagnostic({
      bridgeTokenPresent: Boolean(bridgeToken),
      expiresIn,
      message: refreshHandoff
        ? "http_only_refresh_handoff"
        : accessToken
        ? "email_confirmation_handoff"
        : undefined,
      nextPath,
      status: "callback_loaded",
    });

    if (!bridgeToken && !refreshHandoff && !accessToken) {
      recordLaunchAuthDiagnostic({
        bridgeTokenPresent: false,
        message: "The launch callback URL did not contain a session token.",
        nextPath,
        status: "callback_missing_bridge",
      });
      setError("Sign-in callback is missing a session token.");
      return;
    }

    recordLaunchAuthDiagnostic({
      bridgeTokenPresent: Boolean(bridgeToken),
      expiresIn,
      message: refreshHandoff ? "http_only_refresh_handoff" : undefined,
      nextPath,
      status: "exchange_started",
    });
    const establishSession = bridgeToken
      ? exchangeLaunchBridgeToken(bridgeToken).then((response) => {
        return String(response.expires_in ?? expiresIn ?? "");
      })
      : accessToken
      ? establishLaunchConfirmationSession(accessToken, refreshToken).then(
        (response) => String(response.expires_in ?? expiresIn ?? ""),
      )
      : refreshLaunchSession({ establishSession: true }).then((token) => {
        if (!token) {
          throw new Error("Unable to establish the launch session.");
        }
        return "";
      });

    establishSession
      .then((resolvedExpiresIn) => {
        if (cancelled) return;
        recordLaunchAuthDiagnostic({
          bridgeTokenPresent: Boolean(bridgeToken),
          expiresIn: resolvedExpiresIn,
          message: refreshHandoff ? "http_only_refresh_handoff" : undefined,
          nextPath,
          status: "exchange_succeeded",
        });
        if (!getLaunchAuthToken()) {
          throw new Error("Browser storage rejected the launch session token.");
        }
        recordLaunchAuthDiagnostic({
          bridgeTokenPresent: Boolean(bridgeToken),
          expiresIn: resolvedExpiresIn,
          message: refreshHandoff ? "http_only_refresh_handoff" : undefined,
          nextPath,
          status: "token_stored",
        });
        window.location.replace(nextPath);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        recordLaunchAuthDiagnostic({
          bridgeTokenPresent: Boolean(bridgeToken),
          expiresIn,
          message,
          nextPath,
          status: "exchange_failed",
        });
        setError(message);
      });

    return () => {
      cancelled = true;
    };
  }, [location.search]);

  return (
    <NebulaSessionRestoringShell
      agentOpen={false}
      error={error}
      heading="Connect AI"
    />
  );
}

function MailCheckIcon(): ReactElement {
  return (
    <svg
      fill="none"
      height={24}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
      width={24}
    >
      <path d="M4 6h16v12H4z" />
      <path d="m4 7 8 6 8-6" />
      <path d="m14.5 16 1.5 1.5 3-3" />
    </svg>
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
