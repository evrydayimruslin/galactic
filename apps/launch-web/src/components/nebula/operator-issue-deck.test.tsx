import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchOperatorAttentionProjection,
  LaunchOperatorRemediation,
  LaunchOperatorRoutineRunDetail,
} from "../../../../../shared/contracts/launch.ts";
import {
  OperatorIssueDeck,
  runOnceFailureMessage,
} from "./operator-issue-deck";

const MAIL_AGENT = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "mail-ops",
  name: "Mail Ops",
};
const RESEARCH_AGENT = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "research",
  name: "Research",
};
const ITEM_ID = "33333333-3333-4333-8333-333333333333";

function remediation(
  value: LaunchOperatorRemediation,
): LaunchOperatorRemediation {
  return value;
}

function projection(): LaunchOperatorAttentionProjection {
  return {
    contractVersion: "2026-07-24.operator-issues.1",
    items: [{
      item: {
        id: ITEM_ID,
        conditionKey: "account:byok:openai",
        itemClass: "issue",
        scope: { kind: "account" },
        severity: "warning",
        diagnosis: {
          code: "ACCOUNT_BYOK_MISSING",
          causeCode: "PROVIDER_NOT_CONFIGURED",
          summary: "Configure OpenAI",
          detail: "Two Agents need an inference provider before they can run.",
          provenance: "platform",
          evidence: [{
            kind: "setting",
            sourceId: "provider:openai",
            label: "OpenAI is not configured",
            observedAt: "2026-07-24T18:00:00.000Z",
          }],
        },
        affectedAgents: [
          { agentId: MAIL_AGENT.id, blocking: true },
          { agentId: RESEARCH_AGENT.id, blocking: true },
        ],
        remediations: [
          remediation({
            id: "configure",
            key: "configure_provider",
            label: "Configure provider",
            description: null,
            presentation: "inline",
            requiredAuthority: "account_session",
            sideEffect: "configuration_write",
            target: { kind: "account_provider", provider: "openai" },
          }),
          remediation({
            id: "inspect",
            key: "inspect_run",
            label: "View failed run",
            description: null,
            presentation: "navigate",
            requiredAuthority: "account_session",
            sideEffect: "none",
            target: {
              kind: "routine_run",
              agentId: MAIL_AGENT.id,
              routineId: "routine-1",
              runId: "44444444-4444-4444-8444-444444444444",
            },
          }),
          remediation({
            id: "execute",
            key: "run_once",
            label: "Run once",
            description: "Runs the routine with real side effects.",
            presentation: "execute",
            requiredAuthority: "agent_operate",
            sideEffect: "routine_execution",
            target: {
              kind: "routine",
              agentId: MAIL_AGENT.id,
              routineId: "routine-1",
            },
          }),
        ],
        requiresAction: true,
        requiresDecision: false,
        ordering: { sourceOrdinal: 0, dependsOnConditionKeys: [] },
        recovery: {
          mode: "revalidate_condition",
          mayRecoverAutomatically: true,
          resumesScheduledWork: false,
        },
        detectedAt: "2026-07-24T18:00:00.000Z",
      },
      attention: {
        state: "open",
        readAt: null,
        snoozedUntil: null,
        dismissedAt: null,
      },
    }],
    agentCounts: [
      {
        agent: MAIL_AGENT,
        openCount: 1,
        requiresDecisionCount: 0,
        blockingCount: 1,
      },
      {
        agent: RESEARCH_AGENT,
        openCount: 1,
        requiresDecisionCount: 0,
        blockingCount: 1,
      },
    ],
    openCount: 1,
    requiresDecisionCount: 0,
    blockingCount: 1,
    nextCursor: null,
    available: true,
    unavailableReason: null,
    generatedAt: "2026-07-24T18:00:00.000Z",
  };
}

describe("OperatorIssueDeck", () => {
  it("renders one shared issue with direct safe remediations and affected Agents", () => {
    const markup = renderToStaticMarkup(
      <OperatorIssueDeck
        onNavigate={() => {}}
        projection={projection()}
        showAffectedAgents
      />,
    );

    expect(markup).toContain("Configure OpenAI");
    expect(markup).toContain("PROVIDER_NOT_CONFIGURED");
    expect(markup).toContain("Configure provider");
    expect(markup).toContain("Mail Ops · blocked");
    expect(markup).toContain("Research · blocked");
    expect(markup).toContain("View failed run");
    expect(markup).toContain(
      "pane=routines&amp;item=run%3A44444444-4444-4444-8444-444444444444",
    );
    expect(markup).toContain(
      'aria-label="Mark read; keep this card open while clearing its unread state"',
    );
    expect(markup).not.toContain(
      'aria-label="Mark resolved; hide this card without claiming the underlying condition is fixed"',
    );
    expect(markup).toContain("Mark resolved");
    expect(markup).toContain("Run once");
    expect(markup).not.toContain("real side effects");
    expect(markup).not.toContain("API key");
  });

  it("deep-links by canonical item id without interpreting diagnosis prose", () => {
    const markup = renderToStaticMarkup(
      <OperatorIssueDeck
        itemId={ITEM_ID}
        onNavigate={() => {}}
        projection={projection()}
      />,
    );
    expect(markup).toContain("neb-deep-link-target");

    const proseLink = renderToStaticMarkup(
      <OperatorIssueDeck
        itemId="Configure OpenAI"
        onNavigate={() => {}}
        projection={projection()}
      />,
    );
    expect(proseLink).not.toContain("neb-deep-link-target");
    expect(proseLink).toContain("This item is no longer active.");
    expect(proseLink).not.toContain("Nothing needs your attention.");
  });

  it("labels external diagnosis provenance instead of presenting it as platform fact", () => {
    const combined = projection();
    combined.items[0].item.diagnosis.provenance = "combined";
    const markup = renderToStaticMarkup(
      <OperatorIssueDeck
        onNavigate={() => {}}
        projection={combined}
      />,
    );

    expect(markup).toContain("Platform condition · External diagnosis");
  });
});

describe("Run once result messaging", () => {
  const detail = {
    contractVersion: "2026-07-24.operator-diagnostics.1",
    agent: MAIL_AGENT,
    routine: {
      id: "55555555-5555-4555-8555-555555555555",
      name: "Mail check",
      status: "paused",
    },
    run: {
      id: "44444444-4444-4444-8444-444444444444",
      status: "failed",
      trigger: "manual",
      traceId: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      usage: 0,
      summary: "Generic safe summary",
    },
    diagnostic: {
      version: 1,
      code: "IMAP_AUTH_FAILED",
      causeCode: "AUTHENTICATION_FAILED",
      summary: "The configured mailbox rejected authentication.",
      detail: null,
      provenance: "combined",
      retryable: true,
      redacted: true,
    },
    steps: [],
    logReceipts: [],
    generatedAt: "2026-07-24T18:05:00.000Z",
  } satisfies LaunchOperatorRoutineRunDetail;

  it("prefers the bounded secret-safe diagnostic returned by the backend", () => {
    expect(runOnceFailureMessage(detail)).toBe(
      "The configured mailbox rejected authentication.",
    );
  });

  it("explains a skipped verification when no safe diagnostic is available", () => {
    expect(runOnceFailureMessage({
      ...detail,
      diagnostic: null,
      run: { ...detail.run, status: "skipped", summary: null },
    })).toBe(
      "The verification run did not start because its conditions changed.",
    );
  });
});
