import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LaunchAgentKnowledgeProjection } from "../../../../../shared/contracts/launch.ts";
import { AgentStudioKnowledge } from "./agent-studio-knowledge";

function projection(
  overrides: Partial<LaunchAgentKnowledgeProjection> = {},
): LaunchAgentKnowledgeProjection {
  return {
    facts: [{
      id: "fact-1",
      slug: "check-out",
      title: "Check-out",
      content: "By 11:00. Late check-out to 13:00 is €40.",
      source: "owner",
      status: "active",
      revision: 2,
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    }, {
      id: "fact-2",
      slug: "parking",
      title: null,
      content: "Eight spaces, first come. €18 per night.",
      source: "agent",
      status: "active",
      revision: 1,
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z",
    }],
    questions: [{
      id: "question-1",
      question: "What is the refund window on non-refundable rates?",
      context: "Hit while answering a cancellation request.",
      status: "open",
      askCount: 2,
      blocking: true,
      firstAskedAt: "2026-07-26T10:00:00.000Z",
      lastAskedAt: "2026-07-27T10:00:00.000Z",
      answeredFactId: null,
    }],
    generatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("Agent Studio Knowledge pane (WO-5)", () => {
  it("renders open questions with ask counts and blocking state", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioKnowledge
        agentLocator="agent-1"
        initialProjection={projection()}
      />,
    );
    expect(markup).toContain(
      "What is the refund window on non-refundable rates?",
    );
    expect(markup).toContain("asked 2 times");
    expect(markup).toContain("holding work");
    expect(markup).toContain("Teach it");
  });

  it("renders facts with stable slugs and honest source labels", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioKnowledge
        agentLocator="agent-1"
        initialProjection={projection()}
      />,
    );
    expect(markup).toContain("check-out");
    expect(markup).toContain("you wrote this");
    expect(markup).toContain("learned by the agent");
    // The honesty note about what is NOT here yet stays visible.
    expect(markup).toContain("not enforced policy");
  });

  it("shows calm empty states instead of placeholders", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioKnowledge
        agentLocator="agent-1"
        initialProjection={projection({ facts: [], questions: [] })}
      />,
    );
    expect(markup).toContain("Nothing is waiting on you.");
    expect(markup).toContain("Teach the first fact below");
  });
});
