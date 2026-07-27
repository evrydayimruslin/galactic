import { describe, expect, it } from "vitest";

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
});
