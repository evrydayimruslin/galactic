import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectTutorialPanel } from "../components/connect-tutorial";
import {
  connectTutorialHeroTitle,
  connectTutorialHref,
  parseConnectTutorialContext,
} from "./connect-tutorial";
import { resolveLaunchRoute } from "./routes";

describe("connect tutorial routing", () => {
  it("uses one canonical URL for generic connection", () => {
    expect(connectTutorialHref({ intent: "connect" })).toBe("/connect");
    expect(resolveLaunchRoute("/connect").definition.key).toBe("connect");
  });

  it("routes credential-free session handoffs through the auth callback surface", () => {
    expect(resolveLaunchRoute("/session/complete").definition.key).toBe(
      "authCallback",
    );
  });

  it("keeps feature and Agent context in the URL", () => {
    expect(connectTutorialHref({
      agentSlug: "mail room",
      intent: "interface",
      source: "agent-pane",
    })).toBe(
      "/connect?intent=interface&agent=mail+room&source=agent-pane",
    );
  });

  it("falls back safely when an unknown intent is requested", () => {
    expect(parseConnectTutorialContext("?intent=unknown&source=settings"))
      .toEqual({ intent: "connect", source: "settings" });
  });

  it("uses the Agent display name in every targeted hero", () => {
    expect(connectTutorialHeroTitle("interface", "Email Operations"))
      .toBe("Give Email Operations a purpose-built interface.");
    expect(connectTutorialHeroTitle("function", "Email Operations"))
      .toBe("Extend what Email Operations can do.");
    expect(connectTutorialHeroTitle("routine", "Email Operations"))
      .toBe("Give Email Operations recurring work.");
  });

  it("renders the shared lazy handoff inside the Nebula workspace panel", () => {
    const markup = renderToStaticMarkup(createElement(ConnectTutorialPanel, {
      agent: {
        id: "53e6d85e-f5c2-4778-a284-05889778356b",
        slug: "email-ops",
        name: "Email Operations",
        kind: "mcp",
        visibility: "private",
        relationship: "owner",
        owner: {
          userId: "owner-1",
          displayName: "Ada",
        },
        installed: true,
      },
      location: {
        pathname: "/connect",
        search: "?intent=function&agent=email-ops&source=agent-pane",
      },
      onSignIn: () => undefined,
      signedIn: true,
    }));

    expect(markup).toContain("neb-inline-panel neb-connect-tutorial-panel");
    expect(markup).toContain("agent-studio-handoff-layout");
    expect(markup).toContain("Write a capability for Email Operations");
    expect(markup).toContain("Required · what should it be able to do?");
    expect(markup).toContain("issued when copied");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("email-ops");
    expect(markup).not.toContain("Preparing your scoped coding-agent prompt");
  });

  it("keeps the signed-out draft flow inside the same Connect tutorial", () => {
    const markup = renderToStaticMarkup(createElement(ConnectTutorialPanel, {
      location: {
        pathname: "/connect",
        search: "",
      },
      onSignIn: () => undefined,
      signedIn: false,
    }));

    expect(markup).toContain("neb-connect-tutorial-panel");
    expect(markup).toContain("Sign in to Galactic");
    expect(markup).toContain(
      "Nothing is copied until you sign in.",
    );
    expect(markup).not.toContain("Copy prompt");
  });
});
