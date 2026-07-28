import { describe, expect, it } from "vitest";

import {
  AGENT_STUDIO_PANE_REGISTRY,
  normalizeAgentStudioPane,
  parseAgentStudioRouteState,
  updateAgentStudioRoute,
} from "./agent-studio-route";

describe("Agent Studio routing", () => {
  it("keeps the handoff information architecture in one ordered registry", () => {
    expect(AGENT_STUDIO_PANE_REGISTRY.map((pane) => pane.id)).toEqual([
      "overview",
      "interfaces",
      "approvals",
      "activity",
      "alerts",
      "directive",
      "routines",
      "knowledge",
      "capabilities",
      "connections",
      "compute",
      "limits",
      "settings",
    ]);
  });

  it("preserves legacy Agent deep links", () => {
    expect(normalizeAgentStudioPane("functions")).toBe("capabilities");
    expect(normalizeAgentStudioPane("access")).toBe("connections");
    expect(parseAgentStudioRouteState("?pane=functions&item=send_reply"))
      .toEqual({ pane: "capabilities", item: "send_reply" });
    expect(parseAgentStudioRouteState("?item=activity"))
      .toEqual({ pane: "activity" });
    expect(parseAgentStudioRouteState("?pane=overview&item=activity"))
      .toEqual({ pane: "activity" });
    expect(parseAgentStudioRouteState(
      "?pane=overview&item=interface%3Ainbox",
    )).toEqual({ pane: "interfaces", item: "inbox" });
    expect(parseAgentStudioRouteState("?item=interface%3Atriage"))
      .toEqual({ pane: "interfaces", item: "triage" });
    expect(parseAgentStudioRouteState("?pane=settings&item=rate-limits"))
      .toEqual({ pane: "limits" });
  });

  it("writes canonical Studio links and clears stale item targets", () => {
    expect(updateAgentStudioRoute(
      "/agents/email-ops",
      "?pane=functions&item=send_reply&from=alerts",
      { pane: "limits" },
    )).toBe("/agents/email-ops?pane=limits&from=alerts");
    expect(updateAgentStudioRoute(
      "/agents/email-ops",
      "?pane=interfaces&item=inbox",
      { pane: "interfaces", item: null },
    )).toBe("/agents/email-ops?pane=interfaces");
  });
});
