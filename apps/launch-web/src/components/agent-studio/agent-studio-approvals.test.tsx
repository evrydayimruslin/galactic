import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchAgentApprovalsResponse,
  LaunchApprovalEnvelope,
} from "../../../../../shared/contracts/launch.ts";
import {
  AgentStudioApprovals,
  formatExpiry,
  formatWaiting,
} from "./agent-studio-approvals";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function envelope(
  overrides: Partial<LaunchApprovalEnvelope> = {},
): LaunchApprovalEnvelope {
  return {
    id: "appr-1",
    agentId: "agent-1",
    status: "pending",
    revision: "rev-1",
    releaseId: "rel-1",
    releaseVersion: "1.2.0",
    functionName: "send_reply",
    consequence: "external_side_effect",
    inputHash: "hash-1",
    trigger: "schedule",
    runId: "exec-1",
    routineId: "routine-1",
    routineRunId: "run-1",
    traceId: null,
    policyRevision: "prev-1",
    source: { kind: "routine_wake" },
    proposal: {
      argKeys: ["to", "body"],
      preview: { to: "customer@example.com", body: "Thanks — refunded." },
      lossless: true,
    },
    createdAt: "2026-08-03T10:00:00.000Z",
    expiresAt: "2026-08-08T10:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

function responseFixture(): LaunchAgentApprovalsResponse {
  return {
    agent: {
      id: "agent-1",
      slug: "email-ops",
      name: "Email Ops",
      relationship: "owner",
      publicUrl: null,
      adminUrl: null,
    },
    approvals: [
      envelope(),
      envelope({
        id: "appr-2",
        functionName: "buy_credits",
        consequence: "spend",
        source: {
          kind: "routine_wake",
          heldBy: {
            ruleId: "r1",
            policyVersion: 3,
            readback:
              "r1: Hold every `buy_credits` call whose `amount` is greater than 50 — you approve each one in Approvals before it runs.",
          },
        },
        proposal: {
          argKeys: ["amount", "api_key"],
          preview: { amount: 20, api_key: "•••" },
          lossless: false,
        },
      }),
      envelope({
        id: "appr-3",
        functionName: "record_outcome",
        status: "completed",
        resolvedAt: "2026-08-03T11:00:00.000Z",
      }),
      envelope({
        id: "appr-4",
        functionName: "send_reply",
        status: "rejected",
        resolvedAt: "2026-08-03T11:30:00.000Z",
      }),
    ],
    generatedAt: "2026-08-03T12:00:00.000Z",
  };
}

describe("Agent Studio approvals (Pillar P3)", () => {
  it("renders held cards with consequence eyebrows, waiting time, and proposal", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioApprovals
        agentLocator="email-ops"
        initialResponse={responseFixture()}
        now={NOW}
      />,
    );
    expect(markup).toContain("Leaves Galactic");
    expect(markup).toContain("Spends money");
    expect(markup).toContain("waiting 2h");
    expect(markup).toContain("send_reply");
    expect(markup).toContain("customer@example.com");
    expect(markup).toContain("Thanks — refunded.");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Reject");
    expect(markup).toContain("stop asking for this function");
    expect(markup).toContain("expires in 5d");
    // P4: a rule-held card names the rule in the owner's own readback words.
    expect(markup).toContain("Held by your policy —");
    expect(markup).toContain("is greater than 50");
    // The redacted card never leaks and never offers Edit.
    expect(markup).toContain("•••");
    expect(markup).not.toContain("sk-live");
  });

  it("offers Edit only for provably lossless previews", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioApprovals
        agentLocator="email-ops"
        initialResponse={{
          ...responseFixture(),
          approvals: [envelope({
            proposal: {
              argKeys: ["x"],
              preview: { x: "•••" },
              lossless: false,
            },
          })],
        }}
        now={NOW}
      />,
    );
    expect(markup).not.toContain(">Edit<");
  });

  it("separates resolved envelopes with honest outcome labels", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioApprovals
        agentLocator="email-ops"
        initialResponse={responseFixture()}
        now={NOW}
      />,
    );
    expect(markup).toContain("Resolved");
    expect(markup).toContain("approved — done");
    expect(markup).toContain("rejected");
  });

  it("says plainly when nothing waits, pointing at the Ask switch", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioApprovals
        agentLocator="email-ops"
        initialResponse={{ ...responseFixture(), approvals: [] }}
        now={NOW}
      />,
    );
    expect(markup).toContain("Nothing is waiting on you");
    expect(markup).toContain("Ask");
  });

  it("formats waiting and expiry honestly at boundaries", () => {
    expect(formatWaiting("2026-08-03T11:59:40.000Z", NOW)).toBe("just now");
    expect(formatWaiting("2026-08-03T11:30:00.000Z", NOW)).toBe("waiting 30m");
    expect(formatWaiting("2026-08-01T12:00:00.000Z", NOW)).toBe("waiting 2d");
    expect(formatExpiry("2026-08-03T13:30:00.000Z", NOW)).toBe(
      "expires in 2h",
    );
    expect(formatExpiry("2026-08-01T00:00:00.000Z", NOW)).toBe("expired");
  });
});
