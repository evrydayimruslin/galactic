import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchAgentSummary,
  LaunchInterfaceSummary,
} from "../../../../../shared/contracts/launch.ts";
import {
  AgentStudioInterfaces,
  interfaceDeclarationKey,
  interfaceFunctionLabel,
  interfaceReleaseLabel,
} from "./agent-studio-interfaces";

const AGENT: Pick<LaunchAgentSummary, "id" | "slug" | "name"> = {
  id: "agent-1",
  name: "email-ops",
  slug: "email-ops",
};

function iface(
  overrides: Partial<LaunchInterfaceSummary> = {},
): LaunchInterfaceSummary {
  return {
    artifactHash: "a".repeat(64),
    description: "Review and send the replies it has ready.",
    functions: ["inbox_list", "reply_send"],
    id: "inbox",
    label: "Inbox",
    releaseVersion: "2.2.0",
    url: "https://interfaces.connectgalactic.com/inbox.html",
    ...overrides,
  };
}

describe("AgentStudioInterfaces", () => {
  it("renders the handoff list structure from live declarations", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioInterfaces
        agent={AGENT}
        favoriteInterfaceIds={["inbox"]}
        interfaces={[iface()]}
        itemId="inbox"
        onAddInterface={() => undefined}
        onItemChange={() => undefined}
        onToggleFavorite={() => undefined}
      />,
    );

    expect(markup).toContain("The screens email-ops gives you to work with it.");
    expect(markup).toContain("+ Add interface");
    expect(markup).toContain("Inbox");
    expect(markup).toContain("2 functions");
    expect(markup).toContain("Published with v2.2.0");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain(">Open<");
    expect(markup).toContain("Sharing is not available for this Agent yet.");
    expect(markup).toContain("A pinned interface sits on Overview.");
  });

  it("renders an honest first-interface state without fixture data", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioInterfaces
        agent={AGENT}
        favoriteInterfaceIds={[]}
        interfaces={[]}
        onAddInterface={() => undefined}
        onItemChange={() => undefined}
        onToggleFavorite={() => undefined}
      />,
    );

    expect(markup).toContain("No interfaces have been published yet.");
    expect(markup).toContain("Nothing can open here until");
    expect(markup).not.toContain("Inbox");
  });

  it("fails closed for a stale deep link", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioInterfaces
        agent={AGENT}
        favoriteInterfaceIds={[]}
        interfaces={[iface()]}
        itemId="old-interface"
        onAddInterface={() => undefined}
        onItemChange={() => undefined}
        onToggleFavorite={() => undefined}
      />,
    );

    expect(markup).toContain(
      "This Interface is no longer in the live release.",
    );
    expect(markup).toContain("Return to Interfaces");
  });

  it("uses only declaration-backed metadata", () => {
    expect(interfaceFunctionLabel(iface({ functions: ["read"] }))).toBe(
      "1 function",
    );
    expect(interfaceReleaseLabel(iface({ releaseVersion: null }))).toBe(
      "Published in the live release",
    );
  });

  it("keys the viewer by every executable declaration field", () => {
    const original = iface({
      minHeight: 540,
      readModels: [{
        freshForMs: 1_000,
        functionName: "inbox_list",
        prefetchArgs: { folder: "inbox", filters: { unread: true } },
        staleForMs: 5_000,
      }],
    });
    const originalKey = interfaceDeclarationKey(original);

    expect(interfaceDeclarationKey({
      ...original,
      label: "Renamed Inbox",
      description: "Display copy changed.",
    })).toBe(originalKey);
    expect(interfaceDeclarationKey({
      ...original,
      functions: [...original.functions].reverse(),
      readModels: original.readModels?.map((model) => ({
        ...model,
        prefetchArgs: { filters: { unread: true }, folder: "inbox" },
      })),
    })).toBe(originalKey);

    for (const changed of [
      iface({ ...original, artifactHash: "b".repeat(64) }),
      iface({ ...original, releaseVersion: "2.3.0" }),
      iface({ ...original, functions: [...original.functions, "reply_hold"] }),
      iface({ ...original, minHeight: 680 }),
      iface({
        ...original,
        readModels: original.readModels?.map((model) => ({
          ...model,
          staleForMs: 9_000,
        })),
      }),
      iface({
        ...original,
        url: "https://interfaces.connectgalactic.com/inbox-v2.html",
      }),
    ]) {
      expect(interfaceDeclarationKey(changed)).not.toBe(originalKey);
    }
  });
});
