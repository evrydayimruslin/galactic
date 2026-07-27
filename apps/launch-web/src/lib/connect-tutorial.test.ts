import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectTutorialPanel } from "../components/connect-tutorial";
import {
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

  it("renders feature context inside the Nebula workspace panel", () => {
    const markup = renderToStaticMarkup(createElement(ConnectTutorialPanel, {
      location: {
        pathname: "/connect",
        search: "?intent=function&agent=email-ops&source=agent-pane",
      },
    }));

    expect(markup).toContain("neb-inline-panel neb-connect-tutorial-panel");
    expect(markup).toContain("Extend what this Agent can do.");
    expect(markup).toContain("email-ops");
  });
});
