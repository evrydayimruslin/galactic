import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  LaunchCandidateInvitation,
  LaunchCandidateListResponse,
  LaunchSubscriptionResponse,
} from "../../../../shared/contracts/launch.ts";
import type { LaunchNavigate } from "../lib/navigation";
import {
  CandidateInvitations,
  candidateManifestRows,
  checkoutAttemptFromReturn,
  checkoutReturnClearedHref,
  checkoutReturnRequestsCancellation,
  MEMBERSHIP_ATTEMPT_STORAGE_KEY,
} from "./candidate-invitations";

function subscription(active: boolean): LaunchSubscriptionResponse {
  return {
    canManage: active,
    canSubscribe: !active,
    cancelAtPeriodEnd: false,
    capacity: {
      activeAgentLimit: null,
      generatedAt: "2026-07-30T00:00:00.000Z",
      nextEligibleAt: null,
      plan: "pro",
      state: "available",
      weekly: {
        resetsAt: "2026-08-03T00:00:00.000Z",
        state: "available",
        usedPercent: 0,
      },
    },
    currency: "usd",
    currentPeriodEnd: active ? "2026-08-30T00:00:00.000Z" : null,
    generatedAt: "2026-07-30T00:00:00.000Z",
    hasActiveSubscription: active,
    interval: "month",
    plan: "pro",
    planName: "Galactic membership",
    priceCents: 2_000,
    status: active ? "active" : "inactive",
  };
}

function candidate(
  overrides: Partial<LaunchCandidateInvitation> = {},
): LaunchCandidateInvitation {
  return {
    archive: {
      byteCount: 4096,
      digest: "a".repeat(64),
      objectCount: 8,
    },
    blocker: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    deployment: null,
    deploymentReady: true,
    evidence: {
      attestationDigest: "b".repeat(64),
      attestationId: "attestation-1",
      bundleId: `gxb1_${"c".repeat(64)}`,
      documentDigest: "d".repeat(64),
      qualification: {
        cases: {
          declared: 2,
          optional_failed: 0,
          passed: 2,
          required: 2,
        },
        compiler_revision: "compiler-1",
        document_digest: "d".repeat(64),
        effects: { declared: 2, exercised: 1, untested: 1 },
        functions: { declared: 3, exercised: 1 },
        policy_revision: "policy-1",
        profile: "basic",
        release_digest: "e".repeat(64),
        report_digest: "f".repeat(64),
        runtime_revision: "runtime-1",
      },
      releaseDigest: "e".repeat(64),
      reportDigest: "f".repeat(64),
      sourceHash: "1".repeat(64),
    },
    handoffId: "11111111-1111-4111-8111-111111111111",
    id: "11111111-1111-4111-8111-111111111111",
    intent: "agent",
    release: {
      compute: {
        profile: "small",
        secretNames: ["MODEL_TOKEN"],
        tools: ["browser"],
      },
      description: "Keeps the shared inbox organized.",
      functions: [{
        authorityLevel: "external_write",
        description: "Adds an approved label.",
        effects: [{ id: "gmail.modify", policy: "ask" }],
        name: "label_message",
      }, {
        authorityLevel: "read",
        description: "Reads unread messages.",
        effects: [{ id: "gmail.read", policy: "free" }],
        name: "read_inbox",
      }, {
        authorityLevel: null,
        description: "Builds a summary.",
        effects: [],
        name: "summarize",
      }],
      interfaces: [{
        description: "Inbox review",
        functions: ["read_inbox", "label_message"],
        id: "inbox",
        label: "Inbox",
      }],
      name: "Inbox Keeper",
      network: [{
        description: "Gmail API",
        host: "gmail.googleapis.com",
        label: "Gmail",
      }],
      permissions: ["inference.generate"],
      routines: [{
        description: "Checks for new mail",
        handler: "read_inbox",
        hasDefaultSchedule: true,
        id: "triage",
        label: "Inbox triage",
      }],
      settings: [{
        description: "OAuth refresh token",
        destination: "gmail.googleapis.com",
        key: "GMAIL_TOKEN",
        label: "Gmail connection",
        required: true,
        scope: "agent",
        secret: true,
      }],
      version: "1.0.0",
    },
    reviewRevision: "review-1",
    status: "ready",
    target: {
      kind: "new_agent",
      reservedAgentId: "22222222-2222-4222-8222-222222222222",
    },
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function response(active: boolean): LaunchCandidateListResponse {
  return {
    candidates: [candidate()],
    generatedAt: "2026-07-30T00:00:00.000Z",
    subscription: subscription(active),
  };
}

function deployedCandidate(
  overrides: Partial<LaunchCandidateInvitation> = {},
): LaunchCandidateInvitation {
  return candidate({
    deployment: {
      agent: {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Inbox Keeper",
        setupRequired: true,
        slug: "inbox-keeper",
        version: "1.0.0",
      },
      completedAt: "2026-07-30T01:00:00.000Z",
      deploymentId: "44444444-4444-4444-8444-444444444444",
    },
    deploymentReady: false,
    status: "deployed",
    ...overrides,
  });
}

describe("candidate invitations", () => {
  it("renders the six manifest rows in the locked order", () => {
    expect(candidateManifestRows(candidate()).map((row) => row.label)).toEqual([
      "Routines",
      "Database",
      "Interfaces",
      "Functions",
      "Virtual machine",
      "Inference",
    ]);
  });

  it("recognizes canonical ai:call and ai:embed inference permissions", () => {
    const invitation = candidate();
    invitation.release.permissions = ["ai:call", "ai:embed"];

    expect(
      candidateManifestRows(invitation).find((row) =>
        row.label === "Inference"
      )?.value,
    ).toBe("ai:call, ai:embed");
  });

  it("shows all owner-safe disclosures and defaults eligible candidates on", () => {
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        location={{ pathname: "/", search: "" }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
        response={response(true)}
      />,
    );

    expect(markup).toContain("Review what your coding Agent built");
    expect(markup).toContain("payment never deploys them");
    expect(markup).toContain("Routines");
    expect(markup).toContain("Database");
    expect(markup).toContain("Interfaces");
    expect(markup).toContain("Functions");
    expect(markup).toContain("Virtual machine");
    expect(markup).toContain("Inference");
    expect(markup).toContain("gmail.modify (ask)");
    expect(markup).toContain("gmail.googleapis.com");
    expect(markup).toContain(
      "Gmail connection (GMAIL_TOKEN) · required · agent · secret",
    );
    expect(markup).toContain("Variable: MODEL_TOKEN");
    expect(markup).toContain("inference.generate");
    expect(markup).toContain("Galactic test passed · 2 cases · 1 of 3");
    expect(markup).toContain('type="checkbox" checked=""');
    expect(markup).toContain("Deploy 1 selected Agent");
    expect(markup).toContain("Routines stay");
    expect(markup).toContain("explicitly activate");
  });

  it("fails closed and offers membership when subscription is inactive", () => {
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        location={{ pathname: "/", search: "" }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
        response={response(false)}
      />,
    );

    expect(markup).toContain("Membership required");
    expect(markup).toContain("Start membership — $20/month");
    expect(markup).not.toContain(">Deploy 1 selected Agent</button>");
  });

  it("renders the funnel membership invitation without implying payment deploys", () => {
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        checkoutReturnPath="/connect?intent=agent&step=review"
        location={{
          pathname: "/connect",
          search: "?intent=agent&step=review",
        }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
        response={response(false)}
        variant="funnel"
      />,
    );

    expect(markup).toContain("Galactic membership · $20 a month");
    expect(markup).toContain("1 Agent is built, not deployed");
    expect(markup).toContain(
      "Membership unlocks deployment. Nothing is deployed until you confirm.",
    );
    expect(markup).toContain("Exact-tested releases");
    expect(markup).toContain("Private until you decide");
    expect(markup).toContain("Start membership — $20/month");
    expect(markup).not.toContain("Deploys immediately");
  });

  it("does not offer checkout or deployment when the candidate list is unknown", () => {
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        error="Built Agents could not be loaded."
        location={{ pathname: "/", search: "" }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
      />,
    );

    expect(markup).toContain("Deployment is unavailable");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Start membership — $20/month");
    expect(markup).not.toContain(">Deploy ");
  });

  it("recovers a completed deployment after reload and routes setup explicitly", () => {
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        location={{
          pathname: "/connect",
          search: "?intent=agent&step=review",
        }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
        response={{
          ...response(true),
          candidates: [deployedCandidate()],
        }}
        variant="funnel"
      />,
    );

    expect(markup).toContain("Your Agent is deployed. Setup is next.");
    expect(markup).toContain("Private deployment complete");
    expect(markup).toContain("Inbox Keeper");
    expect(markup).toContain("Continue setup");
    expect(markup).not.toContain("Start membership");
    expect(markup).not.toContain("Deploy 1 selected Agent");
  });

  it("keeps completed receipts visible beside remaining candidates", () => {
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        location={{ pathname: "/", search: "" }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
        response={{
          ...response(true),
          candidates: [
            candidate(),
            deployedCandidate({
              id: "55555555-5555-4555-8555-555555555555",
            }),
          ],
        }}
      />,
    );

    expect(markup).toContain("Review what your coding Agent built");
    expect(markup).toContain("Private deployment complete");
    expect(markup).toContain("Deploy 1 selected Agent");
  });

  it("renders a durable in-progress candidate as resumable instead of deploy-ready", () => {
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        location={{ pathname: "/connect", search: "?intent=agent&step=review" }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
        response={{
          ...response(true),
          candidates: [candidate({ status: "deploying" })],
        }}
        variant="funnel"
      />,
    );

    expect(markup).toContain("Deployment in progress");
    expect(markup).toContain("Resume Agent deployment");
    expect(markup).toContain('disabled="" type="checkbox" checked=""');
    expect(markup).not.toContain(">Deploy 1 selected Agent</button>");
  });

  it("surfaces a specific legacy-lineage blocker before generic stale copy", () => {
    const blockerMessage =
      "This extension candidate predates reliable release lineage. Create a fresh handoff.";
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        location={{ pathname: "/", search: "" }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
        response={{
          ...response(true),
          candidates: [candidate({
            blocker: {
              code: "candidate_base_generation_missing",
              message: blockerMessage,
            },
            intent: "function",
            status: "stale",
            target: {
              agentId: "33333333-3333-4333-8333-333333333333",
              agentName: "Inbox Keeper",
              agentSlug: "inbox-keeper",
              baseLineage: {
                releaseDigest: null,
                sourceHash: null,
                stateDigest: "9".repeat(64),
                version: "1.0.0",
              },
              currentVersion: "1.0.0",
              kind: "extension",
              lineageStatus: "stale",
            },
          })],
        }}
      />,
    );

    expect(markup).toContain(blockerMessage);
    expect(markup).not.toContain(
      "Base release changed — rebuild and test this extension",
    );
    expect(markup).not.toContain(">Deploy 1 selected Agent</button>");
  });

  it("renders an actionable empty review instead of a blank funnel", () => {
    const markup = renderToStaticMarkup(
      <CandidateInvitations
        location={{ pathname: "/connect", search: "?step=review" }}
        navigate={vi.fn() as LaunchNavigate}
        onReload={vi.fn()}
        response={{ ...response(false), candidates: [] }}
        variant="funnel"
      />,
    );

    expect(markup).toContain("No tested Agent has arrived yet");
    expect(markup).toContain("Check again");
  });

  it("uses the opaque return attempt before session fallback", () => {
    const storage = {
      getItem: (key: string) =>
        key === MEMBERSHIP_ATTEMPT_STORAGE_KEY ? "stored-attempt" : null,
    };
    expect(checkoutAttemptFromReturn(
      "?subscription_attempt=query-attempt",
      storage,
    )).toBe("query-attempt");
    expect(checkoutAttemptFromReturn("", storage)).toBe("stored-attempt");
    expect(checkoutAttemptFromReturn("", null)).toBeNull();
    expect(checkoutReturnRequestsCancellation(
      "?subscription=cancelled&subscription_attempt=query-attempt",
    )).toBe(true);
    expect(checkoutReturnRequestsCancellation(
      "?subscription=success&subscription_attempt=query-attempt",
    )).toBe(false);
    expect(checkoutReturnClearedHref({
      pathname: "/connect",
      search:
        "?intent=agent&step=review&subscription=success&subscription_attempt=query-attempt",
    })).toBe("/connect?intent=agent&step=review");
  });
});
