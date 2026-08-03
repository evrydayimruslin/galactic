import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchAgentPolicySetsResponse,
} from "../../../../../shared/contracts/launch.ts";
import {
  AgentStudioDirectivePolicy,
  attributionLabel,
} from "./agent-studio-directive-policy";

function responseFixture(): LaunchAgentPolicySetsResponse {
  return {
    agent: {
      id: "agent-1",
      slug: "email-ops",
      name: "Email Ops",
      relationship: "owner",
      publicUrl: null,
      adminUrl: null,
    },
    head: {
      version: 3,
      source: [{ text: "hold refunds over 50", ruleIds: ["r1"] }],
      artifact: {
        version: 1,
        rules: [{
          id: "r1",
          functionName: "issue_refund",
          effect: "hold",
          when: [{ path: "amount", op: "gt", value: 50 }],
        }],
      },
      readback: [
        "r1: Hold every `issue_refund` call whose `amount` is greater than 50 — you approve each one in Approvals before it runs.",
      ],
      compileModel: "anthropic/claude-sonnet-5",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    versions: [
      {
        version: 3,
        createdAt: "2026-08-03T00:00:00.000Z",
        compileModel: "anthropic/claude-sonnet-5",
        ruleCount: 1,
      },
      {
        version: 2,
        createdAt: "2026-08-02T00:00:00.000Z",
        compileModel: "anthropic/claude-sonnet-5",
        ruleCount: 2,
      },
    ],
    generatedAt: "2026-08-03T12:00:00.000Z",
  };
}

describe("Directive compiled policy (Pillar P4)", () => {
  it("renders the live version's readback, model provenance, and history", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioDirectivePolicy
        agentLocator="email-ops"
        initialResponse={responseFixture()}
      />,
    );
    expect(markup).toContain("Compiled policy");
    expect(markup).toContain("Version 3 · compiled by anthropic/claude-sonnet-5");
    expect(markup).toContain("is greater than 50");
    expect(markup).toContain("you approve each one in Approvals");
    // History rows with rule counts.
    expect(markup).toContain("v2");
    expect(markup).toContain("2 rules");
    // The compose affordance is present with an honest placeholder.
    expect(markup).toContain("Never issue refunds over 50 without asking me.");
    expect(markup).toContain("Compile");
  });

  it("states the no-policy posture honestly", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioDirectivePolicy
        agentLocator="email-ops"
        initialResponse={{
          ...responseFixture(),
          head: null,
          versions: [],
        }}
      />,
    );
    expect(markup).toContain("No compiled policy yet");
    expect(markup).toContain("Capabilities switches");
  });
});

describe("Directive attribution + dry-run (Pillar P6)", () => {
  it("shows per-rule counters with See-them navigation", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioDirectivePolicy
        agentLocator="email-ops"
        initialResponse={responseFixture()}
        initialAttribution={{
          agent: responseFixture().agent,
          rules: [{
            ruleId: "r1",
            policyVersion: 3,
            readback: "r1: Hold …",
            heldLast7d: 4,
            pendingNow: 2,
          }],
          versions: [{ policyVersion: 3, held: 4 }],
          windowDays: 7,
          generatedAt: "2026-08-03T12:00:00.000Z",
        }}
        onOpenApprovals={() => undefined}
      />,
    );
    expect(markup).toContain("held 4 this week · 2 waiting now");
    expect(markup).toContain("See them →");
  });

  it("labels counters honestly at the boundaries", () => {
    expect(attributionLabel({ heldLast7d: 1, pendingNow: 0 })).toBe(
      "held 1 this week",
    );
    expect(attributionLabel({ heldLast7d: 6, pendingNow: 6 })).toBe(
      "held 6 this week · 6 waiting now",
    );
  });
});
