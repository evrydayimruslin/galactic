import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchAgentAccessGroup,
  LaunchAgentAccessProjection,
} from "../../../../../shared/contracts/launch.ts";
import {
  AgentStudioConnections,
  settingsPresenceAfterUpdate,
} from "./agent-studio-connections";

function group(
  overrides: Partial<LaunchAgentAccessGroup> = {},
): LaunchAgentAccessGroup {
  return {
    authority: [{
      access: "execute",
      actionId: null,
      approvalBasis: "live_release",
      approved: true,
      badges: ["Write"],
      direction: "outbound",
      effective: true,
      id: "network:imap.example.com",
      kind: "network",
      label: "Reach imap.example.com",
      purpose: "Read the shared mailbox.",
      requested: true,
      required: true,
      source: "manifest",
      target: "imap.example.com",
    }],
    configured: false,
    consumers: [{
      id: "routine-1",
      kind: "routine",
      label: "Check the inbox",
    }],
    credentials: [{
      configured: false,
      key: "IMAP_PASS",
      label: "Password",
      required: true,
    }],
    description: "The mailbox this Agent watches.",
    effective: false,
    id: "access:external:imap.example.com",
    kind: "external_endpoint",
    label: "Hotel mailbox",
    settings: [],
    target: "imap.example.com",
    ...overrides,
  };
}

function projection(
  groups: LaunchAgentAccessGroup[],
): LaunchAgentAccessProjection {
  return {
    configured: groups.every((item) => item.configured),
    effective: groups.every((item) => item.effective),
    groups,
  };
}

describe("Agent Studio Connections", () => {
  it("renders grouped connection presence without reconstructing values", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioConnections
        access={projection([group()])}
        agentIdOrSlug="email-ops"
        agentName="email-ops"
        homeRevision="home-revision-1"
        onHandOffConnection={() => undefined}
        onOpenItem={() => undefined}
      />,
    );

    expect(markup).toContain("Hotel mailbox");
    expect(markup).toContain("External endpoint · imap.example.com");
    expect(markup).toContain("IMAP_PASS · write-only");
    expect(markup).toContain("Value is stored write-only");
    expect(markup).toContain("Not connected");
    expect(markup).not.toContain("••••");
    expect(markup).not.toContain("Test connection");
  });

  it("opens exact setting deep links and keeps the input empty while loading", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioConnections
        access={projection([group()])}
        agentIdOrSlug="email-ops"
        agentName="email-ops"
        homeRevision="home-revision-1"
        itemId="setting:IMAP_PASS"
        onHandOffConnection={() => undefined}
        onOpenItem={() => undefined}
      />,
    );

    expect(markup).toContain('data-focused="true"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Loading configuration");
    expect(markup).not.toContain('value="');
  });

  it("shows stale item deep links explicitly", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioConnections
        access={projection([group()])}
        agentIdOrSlug="email-ops"
        agentName="email-ops"
        homeRevision="home-revision-1"
        itemId="setting:REMOVED_KEY"
        onHandOffConnection={() => undefined}
        onOpenItem={() => undefined}
      />,
    );

    expect(markup).toContain(
      "This connection item is no longer part of the live Agent release.",
    );
    expect(markup).not.toContain('role="dialog"');
  });

  it("renders a truthful no-declarations state with a handoff action", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioConnections
        access={projection([])}
        agentIdOrSlug="new-agent"
        agentName="new-agent"
        homeRevision="home-revision-1"
        onHandOffConnection={() => undefined}
        onOpenItem={() => undefined}
      />,
    );

    expect(markup).toContain("No outside connections are declared.");
    expect(markup).toContain("Add with your coding agent");
  });

  it("updates presence only and still requires effective authority", () => {
    const configured = settingsPresenceAfterUpdate(
      projection([group()]),
      ["IMAP_PASS"],
    );
    expect(configured.groups[0]?.credentials[0]?.configured).toBe(true);
    expect(configured.groups[0]?.configured).toBe(true);
    expect(configured.groups[0]?.configured).toBe(true);
    expect(configured.groups[0]?.effective).toBe(false);

    const blocked = settingsPresenceAfterUpdate(
      projection([group({
        authority: group().authority.map((authority) => ({
          ...authority,
          effective: false,
        })),
      })]),
      ["IMAP_PASS"],
    );
    expect(blocked.groups[0]?.configured).toBe(true);
    expect(blocked.groups[0]?.effective).toBe(false);
  });
});
