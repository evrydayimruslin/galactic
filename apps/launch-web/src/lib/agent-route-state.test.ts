import { describe, expect, it } from "vitest";

import {
  parseAgentRouteState,
  serializeAgentRouteState,
  updateAgentRouteState,
} from "./agent-route-state";

describe("Agent route state", () => {
  it("keeps legacy Agent URLs compatible by defaulting to Overview", () => {
    expect(parseAgentRouteState({
      pathname: "/agents/email-ops",
      search: "",
    })).toEqual({
      pane: "overview",
      slug: "email-ops",
    });
  });

  it("parses pane and granular item destinations", () => {
    expect(parseAgentRouteState({
      pathname: "/agents/email%20ops/",
      search: "?pane=functions&item=send_reply",
    })).toEqual({
      item: "send_reply",
      pane: "functions",
      slug: "email ops",
    });
  });

  it("falls back safely for invalid panes and non-Agent paths", () => {
    expect(parseAgentRouteState({
      pathname: "/agents/email-ops",
      search: "?pane=not-a-pane",
    })?.pane).toBe("overview");
    expect(parseAgentRouteState({
      pathname: "/account",
      search: "?pane=settings",
    })).toBeNull();
  });

  it("serializes stable links while preserving unrelated navigation context", () => {
    expect(serializeAgentRouteState({
      item: "send reply",
      pane: "functions",
      slug: "email ops",
    }, "?from=alerts")).toBe(
      "/agents/email%20ops?from=alerts&pane=functions&item=send+reply",
    );
    expect(serializeAgentRouteState({
      pane: "overview",
      slug: "email-ops",
    })).toBe("/agents/email-ops");
  });

  it("clears a stale item when moving to another pane", () => {
    expect(updateAgentRouteState({
      pathname: "/agents/email-ops",
      search: "?from=alerts&pane=functions&item=send_reply",
    }, {
      pane: "interfaces",
    })).toBe("/agents/email-ops?from=alerts&pane=interfaces");
  });

  it("opens, replaces, and closes same-pane items without losing context", () => {
    const location = {
      pathname: "/agents/email-ops",
      search: "?from=alerts&pane=functions",
    };
    expect(updateAgentRouteState(location, { item: "send_reply" })).toBe(
      "/agents/email-ops?from=alerts&pane=functions&item=send_reply",
    );
    expect(updateAgentRouteState({
      ...location,
      search: "?from=alerts&pane=functions&item=send_reply",
    }, { item: "archive_message" })).toBe(
      "/agents/email-ops?from=alerts&pane=functions&item=archive_message",
    );
    expect(updateAgentRouteState({
      ...location,
      search: "?from=alerts&pane=functions&item=archive_message",
    }, { item: null })).toBe(
      "/agents/email-ops?from=alerts&pane=functions",
    );
  });

  it("round-trips the same states a browser Back/Forward sequence restores", () => {
    const history = [
      "/agents/email-ops",
      "/agents/email-ops?pane=interfaces",
      "/agents/email-ops?pane=functions&item=send_reply",
    ];

    const restored = history.map((path) => {
      const url = new URL(path, "https://connectgalactic.com");
      return parseAgentRouteState(url);
    });

    expect(restored.map((state) => state?.pane)).toEqual([
      "overview",
      "interfaces",
      "functions",
    ]);
    expect(restored[2]?.item).toBe("send_reply");
    expect(restored.reverse().map((state) =>
      state ? serializeAgentRouteState(state) : null
    )).toEqual([...history].reverse());
  });
});
