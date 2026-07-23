import { describe, expect, it } from "vitest";

import {
  AGENT_PANE_REGISTRY,
  agentPaneLabel,
  agentPanesInGroup,
  DEFAULT_AGENT_PANE,
  isAgentPane,
} from "./agent-pane-registry";

describe("agent pane registry", () => {
  it("keeps one canonical ordered menu definition", () => {
    expect(AGENT_PANE_REGISTRY.map((pane) => pane.id)).toEqual([
      "overview",
      "interfaces",
      "alerts",
      "access",
      "routines",
      "functions",
      "compute",
      "settings",
    ]);
    expect(new Set(AGENT_PANE_REGISTRY.map((pane) => pane.id)).size)
      .toBe(AGENT_PANE_REGISTRY.length);
    expect(DEFAULT_AGENT_PANE).toBe("overview");
  });

  it("provides the existing Operate and Manage groups", () => {
    expect(agentPanesInGroup("operate").map((pane) => pane.id)).toEqual([
      "overview",
      "interfaces",
      "alerts",
    ]);
    expect(agentPanesInGroup("manage").map((pane) => pane.id)).toEqual([
      "access",
      "routines",
      "functions",
      "compute",
      "settings",
    ]);
  });

  it("validates URLs and resolves labels from the same registry", () => {
    expect(isAgentPane("functions")).toBe(true);
    expect(isAgentPane("access")).toBe(true);
    expect(isAgentPane(null)).toBe(false);
    expect(agentPaneLabel("interfaces")).toBe("Interfaces");
  });
});
