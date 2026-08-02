import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LaunchAgentConceptAbout } from "../../../../../shared/contracts/launch.ts";
import { AgentStudioConcepts } from "./agent-studio-concepts";

const glossary = [
  {
    id: "c1",
    slug: "refund-window",
    title: "Refund window",
    description: "Money-back rules per rate type.",
    status: "active" as const,
    createdBy: "schema" as const,
    aliases: ["money-back"],
    embeddingStatus: "ready" as const,
    embeddingModel: "text-embedding-3-small",
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
    mentionCount: 4,
  },
  {
    id: "c2",
    slug: "dog-policy",
    title: null,
    description: null,
    status: "provisional" as const,
    createdBy: "mention" as const,
    aliases: [],
    embeddingStatus: "none" as const,
    embeddingModel: null,
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
    mentionCount: 1,
  },
];

function aboutFixture(): LaunchAgentConceptAbout {
  return {
    concept: { ...glossary[0], aliases: ["money-back"] },
    mentionGroups: [
      {
        surfaceType: "schema_field",
        mentions: [{
          surfaceId: "issue_refund.refund_window",
          blockId: "refund_window",
          blockText: "The window in which refunds are honored.",
          identity: true,
          releaseId: "rel-1",
          fieldPath: "args.refund_window",
          createdAt: "2026-08-02T10:00:00.000Z",
        }],
      },
      {
        surfaceType: "fact",
        mentions: [{
          surfaceId: "check-out",
          blockId: "b0",
          blockText: "Late check-out interacts with [[refund-window]].",
          identity: false,
          releaseId: null,
          fieldPath: null,
          createdAt: "2026-08-02T09:00:00.000Z",
        }],
      },
    ],
    relatedConcepts: [{ slug: "cancellation-policy", title: null }],
    generatedAt: "2026-08-02T12:00:00.000Z",
  };
}

describe("Agent Studio concept glossary (WO-6 PR C)", () => {
  it("lists concepts with mention counts and flags provisionals", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioConcepts
        agentLocator="agent-1"
        initialConcepts={glossary}
      />,
    );
    expect(markup).toContain("[[refund-window]]");
    expect(markup).toContain("4 mentions");
    expect(markup).toContain("provisional");
    expect(markup).toContain("1 awaiting a description");
  });

  it("teaches the empty state instead of hiding it", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioConcepts agentLocator="agent-1" initialConcepts={[]} />,
    );
    expect(markup).toContain("glossary builds itself");
  });

  it("renders the concept page: identity first, layers labeled, related linked", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioConcepts
        agentLocator="agent-1"
        initialConcepts={glossary}
        initialAbout={aboutFixture()}
      />,
    );
    expect(markup).toContain("Declared in the release schema");
    expect(markup).toContain("declared identity · args.refund_window");
    expect(markup).toContain("Late check-out interacts with");
    expect(markup).toContain("Also answers to:");
    expect(markup).toContain("[[money-back]]");
    expect(markup).toContain("[[cancellation-policy]]");
    expect(markup).toContain("Money-back rules per rate type.");
  });
});
