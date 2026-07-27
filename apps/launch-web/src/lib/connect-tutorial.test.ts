import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectTutorialPanel } from "../components/connect-tutorial";
import {
  connectTutorialApiKeyRequest,
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

  it("provisions least-privilege keys for each tutorial instance", () => {
    const agent = {
      id: "app-email-ops",
      slug: "email-ops",
      name: "Email Operations",
      kind: "mcp" as const,
      visibility: "private" as const,
      relationship: "owner" as const,
      owner: { userId: "owner-1" },
      installed: true,
    };

    expect(connectTutorialApiKeyRequest({
      intent: "connect",
      suffix: "one",
    })).toMatchObject({
      scopes: ["apps:read"],
    });
    expect(connectTutorialApiKeyRequest({
      agent,
      intent: "routine",
      suffix: "two",
    })).toMatchObject({
      appIds: ["app-email-ops"],
      scopes: ["apps:read", "apps:call", "agents:build", "agents:operate"],
    });
    expect(connectTutorialApiKeyRequest({
      intent: "agent",
      suffix: "three",
    })).not.toHaveProperty("appIds");
  });

  it("renders feature context inside the Nebula workspace panel", () => {
    const markup = renderToStaticMarkup(createElement(ConnectTutorialPanel, {
      agent: {
        id: "app-email-ops",
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
    expect(markup).toContain("Preparing your scoped coding-agent prompt");
    expect(markup).toContain('aria-label="Extend what Email Operations can do."');
    expect(markup).not.toContain("email-ops");
    expect(markup).not.toContain("neb-connect-tutorial-title");
    expect(markup).not.toContain("Sign in to continue");
  });

  it("keeps sign-in inside the same Connect tutorial", () => {
    const markup = renderToStaticMarkup(createElement(ConnectTutorialPanel, {
      location: {
        pathname: "/connect",
        search: "",
      },
      onSignIn: () => undefined,
      signedIn: false,
    }));

    expect(markup).toContain("neb-connect-tutorial-panel");
    expect(markup).toContain("Sign in to continue");
    expect(markup).toContain(
      "Sign in to provision a scoped prompt for your coding agent.",
    );
  });
});
