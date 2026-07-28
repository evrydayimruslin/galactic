import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentStudioHandoff } from "./agent-studio-handoff";

const target = {
  capabilityGroupCount: 4,
  functionCount: 18,
  id: "53e6d85e-f5c2-4778-a284-05889778356b",
  name: "email-ops",
  releaseVersion: "2.2.0",
  routineCount: 3,
};
const sessionId = "7a8c99b7-2875-4a6a-9490-8f03c99587c1";
const platformMcpUrl = "https://api.galactic.dev/mcp/platform";
const bearerToken = "gx_0123456789abcdef0123456789abcdef";

describe("AgentStudioHandoff", () => {
  it("renders the two-column ring, three beats, exact target and gated Copy", () => {
    const createCredential = vi.fn(async () => ({
      bearerToken,
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      platformMcpUrl,
      scope: { agentId: target.id, kind: "agent" as const },
      sessionId,
      status: "issued" as const,
    }));
    const markup = renderToStaticMarkup(
      <AgentStudioHandoff
        createCredential={createCredential}
        initialIntent="interface"
        target={target}
      />,
    );

    expect(markup).toContain("agent-studio-handoff-layout");
    expect(markup).toContain("this prompt");
    expect(markup).toContain("a new release");
    expect(markup).toContain("Paste this prompt to your coding agent");
    expect(markup).toContain("Your coding agent asks, builds and stages");
    expect(markup).toContain("then stages the tested candidate");
    expect(markup).toContain("The interface runs on Galactic");
    expect(markup).toContain(target.id);
    expect(markup).toContain("Incomplete");
    expect(markup).toContain("Copy prompt");
    expect(markup).toContain("disabled");
    expect(markup).toContain("[issued securely when you copy]");
    expect(markup).toContain("Claude Code command (run this in a shell)");
    expect(markup).toContain("Portable HTTP MCP client configuration");
    expect(markup).toContain(
      "MCP server entry saved by the client does not expire automatically",
    );
    expect(markup).toContain("Token expires");
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("supports all six intents and preserves seeded descriptions by intent", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioHandoff
        initialDescriptions={{
          agent: "Own reservations.",
          connect: "List my Agents.",
          function: "Look up room inventory.",
          interface: "Show held drafts.",
          routine: "Wake every 15 minutes.",
          "signed-out": "Keep this through sign-in.",
        }}
        initialIntent="signed-out"
        showIntentTabs
        target={target}
      />,
    );

    expect(markup).toContain("New Agent");
    expect(markup).toContain("New interface");
    expect(markup).toContain("New function");
    expect(markup).toContain("New routine");
    expect(markup).toContain("Connect AI");
    expect(markup).toContain("Connect AI · signed out");
    expect(markup).toContain("Keep this through sign-in.");
    expect(markup).toContain("Sign in required");
    expect(markup).toContain("Sign in to Galactic");
    expect(markup).not.toContain("Copy prompt");
  });

  it("does not imply an available short-lived credential without the callback", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioHandoff
        initialDescriptions={{ routine: "Check once an hour." }}
        initialIntent="routine"
        target={target}
      />,
    );

    expect(markup).toContain("Secure key unavailable");
    expect(markup).toContain(
      "No general API key will be substituted.",
    );
    expect(markup).toContain("issued when copied");
    expect(markup).toContain("<dt>Token expires</dt>");
    expect(markup).toContain("not issued");
    expect(markup).toContain("disabled");
  });

  it("becomes ready only when a required request and short-lived issuer exist", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioHandoff
        createCredential={async () => ({
          bearerToken,
          expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
          platformMcpUrl,
          scope: { agentId: target.id, kind: "agent" },
          sessionId,
          status: "issued",
        })}
        initialDescriptions={{
          function: "Check the PMS before quoting a room.",
        }}
        initialIntent="function"
        target={target}
      />,
    );

    expect(markup).toContain("Ready to copy");
    expect(markup).toContain("Check the PMS before quoting a room.");
    expect(markup).toMatch(/<button class="" type="button">Copy prompt<\/button>/);
  });
});
