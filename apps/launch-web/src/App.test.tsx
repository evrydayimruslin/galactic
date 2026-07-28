import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  authToken: "owner-session" as string | null,
  live: null as unknown,
}));

vi.mock("./lib/auth", () => ({
  exchangeLaunchBridgeToken: vi.fn(),
  getLaunchAuthToken: () => appState.authToken,
  isLaunchAuthSessionStorageChange: () => false,
  isLaunchRefreshAvailable: () => false,
  LAUNCH_AUTH_SESSION_CHANGED_EVENT: "galactic:launch-auth-session-changed",
  launchAuthSessionIdentity: () => "user:viewer-1",
  normalizeLocalPath: (value: string | null | undefined) => value || "/account",
  recordLaunchAuthDiagnostic: vi.fn(),
  refreshLaunchSession: vi.fn(async () => null),
  setLaunchAuthToken: vi.fn(),
}));

vi.mock("./lib/live-data", () => ({
  useLaunchRouteLiveData: () => appState.live,
}));

vi.mock("./lib/external-navigation", () => ({
  consumeExternalReturnRevalidation: () => false,
}));

vi.mock("./components/agent-studio/agent-studio", async () => {
  const { createElement } = await import("react");
  return {
    AgentStudioApp: (
      { location, route }: {
        location: { search: string };
        route: { params: Record<string, string> };
      },
    ) =>
      createElement("div", {
        "data-agent": route.params.slug,
        "data-search": location.search,
        "data-surface": "agent-studio",
      }),
  };
});

vi.mock("./components/launch-chrome", async () => {
  const { createElement } = await import("react");
  return {
    LaunchShell: ({ children }: { children?: ReactNode }) =>
      createElement("div", { "data-shell": "compatibility" }, children),
  };
});

vi.mock("./pages/foundation-pages", async () => {
  const { createElement } = await import("react");
  const page = (surface: string) => () =>
    createElement("div", { "data-surface": surface });
  return {
    AccountFoundationPage: page("account"),
    AdminFoundationPage: page("admin"),
    AgentFoundationPage: page("agent-compatibility"),
    HomeFoundationPage: page("home"),
    LibraryFoundationPage: page("library"),
    PrivacyPage: page("privacy"),
    StoreFoundationPage: page("store"),
    TermsPage: page("terms"),
  };
});

vi.mock("./components/nebula-fleet", async () => {
  const { createElement } = await import("react");
  return {
    NebulaFleetApp: () =>
      createElement("div", { "data-surface": "nebula-fleet" }),
    NebulaSessionRestoringShell: () =>
      createElement("div", { "data-surface": "session-restoring" }),
  };
});

vi.mock("./components/sign-in-modal", async () => {
  const { createElement } = await import("react");
  return {
    SignInModalProvider: ({ children }: { children?: ReactNode }) =>
      createElement("div", null, children),
    useSignInModal: () => vi.fn(),
  };
});

vi.mock("./components/connect-tutorial", async () => {
  const { createElement } = await import("react");
  return {
    ConnectTutorialPanel: () =>
      createElement("div", { "data-surface": "connect" }),
  };
});

import { App } from "./App";

const agent = {
  id: "53e6d85e-f5c2-4778-a284-05889778356b",
  slug: "email-ops",
  name: "Email Ops",
};

beforeEach(() => {
  appState.authToken = "owner-session";
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    history: {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    },
    location: {
      href:
        "https://connectgalactic.com/agents/email-ops?pane=interfaces&item=inbox",
      origin: "https://connectgalactic.com",
      pathname: "/agents/email-ops",
      reload: vi.fn(),
      search: "?pane=interfaces&item=inbox",
    },
    removeEventListener: vi.fn(),
    scrollTo: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App Agent Studio production routing", () => {
  it("renders Agent Studio for the authenticated owner Agent route", () => {
    appState.live = liveState("owner");

    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('data-surface="agent-studio"');
    expect(markup).toContain('data-agent="email-ops"');
    expect(markup).toContain(
      'data-search="?pane=interfaces&amp;item=inbox"',
    );
    expect(markup).not.toContain('data-surface="agent-compatibility"');
  });

  it.each(["installed", "public"] as const)(
    "keeps a resolved %s non-owner on the compatibility Agent surface",
    (relationship) => {
      appState.live = liveState(relationship);

      const markup = renderToStaticMarkup(<App />);

      expect(markup).toContain('data-shell="compatibility"');
      expect(markup).toContain('data-surface="agent-compatibility"');
      expect(markup).not.toContain('data-surface="agent-studio"');
    },
  );
});

function liveState(relationship: "installed" | "owner" | "public") {
  return {
    data: {
      agent: {
        agent: {
          ...agent,
          installed: relationship === "installed",
          kind: "mcp",
          owner: { userId: relationship === "owner" ? "viewer-1" : "other-1" },
          relationship,
          visibility: relationship === "owner" ? "private" : "public",
        },
      },
    },
    reload: vi.fn(),
    status: "ready",
  };
}
