import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchAgentFunctionPoliciesResponse,
  LaunchAutonomousFunctionPolicyProjection,
} from "../../../../../shared/contracts/launch.ts";
import {
  AgentStudioPolicies,
  groupPoliciesByConsequence,
  policyUpdateRequestFor,
} from "./agent-studio-policies";

function projection(
  overrides: Partial<LaunchAutonomousFunctionPolicyProjection>,
): LaunchAutonomousFunctionPolicyProjection {
  return {
    agentId: "agent-1",
    functionName: "send_reply",
    consequence: "external_side_effect",
    policy: "free",
    revision: "default:hash-1",
    declaredReleaseId: "rel-1",
    declaredReleaseVersion: "1.2.0",
    declarationHash: "hash-1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    updatedBy: { kind: "system", source: "release_default" },
    ...overrides,
  };
}

function responseFixture(): LaunchAgentFunctionPoliciesResponse {
  return {
    agent: {
      id: "agent-1",
      slug: "email-ops",
      name: "Email Ops",
      relationship: "owner",
      publicUrl: null,
      adminUrl: null,
    },
    currentRelease: { id: "rel-1", version: "1.2.0" },
    policies: [
      projection({}),
      projection({
        functionName: "check_inbox",
        consequence: "read",
      }),
      projection({
        functionName: "record_outcome",
        consequence: "internal_write",
        policy: "off",
        revision: "rev-7",
        updatedBy: { kind: "user", userId: "user-1" },
      }),
      projection({
        functionName: "buy_credits",
        consequence: "spend",
        policy: "ask",
        revision: "rev-8",
        updatedBy: { kind: "user", userId: "user-1" },
      }),
    ],
    generatedAt: "2026-08-03T00:00:00.000Z",
  };
}

describe("Agent Studio autonomous policies (Pillar P2)", () => {
  it("groups riskiest-first with the mock's consequence vocabulary", () => {
    const groups = groupPoliciesByConsequence(responseFixture().policies);
    expect(groups.map((g) => g.label)).toEqual([
      "Spends money",
      "Leaves Galactic",
      "Changes a fact",
      "Read-only",
    ]);
  });

  it("renders switches with audit lines and honest dormant-ask copy", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioPolicies
        agentLocator="email-ops"
        initialResponse={responseFixture()}
      />,
    );
    expect(markup).toContain("When this Agent acts on its own");
    expect(markup).toContain("Leaves Galactic");
    expect(markup).toContain("send_reply");
    expect(markup).toContain("release default");
    expect(markup).toContain("set by you");
    // The dormant 'ask' row says what actually happens today.
    expect(markup).toContain("runs free until approvals ship");
    // Off is pressed for the off row; the free row presses Free.
    expect(markup).toContain("aria-pressed=\"true\"");
  });

  it("asks for a release before offering switches", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioPolicies
        agentLocator="email-ops"
        initialResponse={{
          ...responseFixture(),
          currentRelease: null,
          policies: [],
        }}
      />,
    );
    expect(markup).toContain("Publish a release first");
  });

  it("builds full-congruence CAS writes from what the owner saw", () => {
    const p = projection({ revision: "rev-42" });
    const request = policyUpdateRequestFor(p, "off");
    expect(request.policy).toBe("off");
    expect(request.expectedRevision).toBe("rev-42");
    expect(request.expectedReleaseId).toBe("rel-1");
    expect(request.expectedDeclarationHash).toBe("hash-1");
    expect(request.idempotencyKey).toBeTruthy();
    // Each attempt is its own idempotency scope.
    expect(policyUpdateRequestFor(p, "off").idempotencyKey).not.toBe(
      request.idempotencyKey,
    );
  });
});
