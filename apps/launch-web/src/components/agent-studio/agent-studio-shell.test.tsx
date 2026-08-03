import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentStudioShell } from "./agent-studio-shell";

describe("AgentStudioShell", () => {
  it("renders the complete handoff rail and a real Agent header", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioShell
        agentName="email-ops"
        badges={{ alerts: 2, approvals: 3 }}
        onBack={() => undefined}
        onPaneChange={() => undefined}
        pane="overview"
        releaseVersion="2.2.0"
        statusLabel="Live"
        statusTone="live"
        theme="dark"
      >
        <p>Studio content</p>
      </AgentStudioShell>,
    );

    expect(markup).toContain('class="agent-studio" data-theme="dark"');
    expect(markup).toContain("email-ops");
    expect(markup).toContain("v2.2.0");
    expect(markup).toContain("Home");
    expect(markup).toContain("Watch");
    expect(markup).toContain("Teach");
    expect(markup).toContain("Grant");
    expect(markup).toContain("Approvals");
    expect(markup).toContain("Knowledge");
    expect(markup).toContain("Capabilities");
    expect(markup).toContain("Connections");
    expect(markup).toContain("Limits");
    expect(markup).toContain("Studio content");
  });

  it("keeps the header free of the retired studio-only controls", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioShell
        agentName="email-ops"
        onBack={() => undefined}
        onPaneChange={() => undefined}
        pane="overview"
        releaseVersion={null}
        statusLabel="Setup"
        statusTone="waiting"
        theme="light"
      >
        <p>Studio content</p>
      </AgentStudioShell>,
    );

    expect(markup).not.toContain("galactic-wordmark");
    expect(markup).not.toContain("agent-studio-wordmark");
    expect(markup).not.toContain("Run now");
    expect(markup).not.toContain("Studio theme");
    expect(markup).not.toContain("agent-studio-settings-button");
    expect(markup).toContain("Settings");
  });
});
