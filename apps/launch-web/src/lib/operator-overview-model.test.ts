import { describe, expect, it } from "vitest";

import type {
  LaunchAgentHomeResponse,
  LaunchInterfaceSummary,
} from "../../../../shared/contracts/launch.ts";
import { buildOperatorOverviewModel } from "./operator-overview-model";

function home(
  overrides: Partial<LaunchAgentHomeResponse> = {},
): LaunchAgentHomeResponse {
  return {
    contractVersion: "2026-07-23.operator.1",
    revision: "agent-home-v1:test",
    generatedAt: "2026-07-23T12:00:00.000Z",
    agent: {
      id: "agent-1",
      slug: "mail",
      name: "Mail",
      description: null,
      visibility: "private",
    },
    responsibility: {
      mission: "Own mail.",
      cadence: null,
      reporting: {
        kind: "galactic_inbox",
        label: "Galactic inbox",
        configured: true,
      },
    },
    state: {
      lifecycle: "active",
      execution: "idle",
      health: "healthy",
      nextRunAt: null,
      lastRunAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      failureCount: 0,
      blockers: [],
    },
    setup: { ready: true, requirements: [] },
    authority: { items: [] },
    capacity: null,
    budget: null,
    release: {
      live: null,
      candidate: null,
      candidateCount: 0,
    },
    recentRuns: [],
    actions: {
      canEditIdentity: true,
      canEditRoutine: true,
      canManageSettings: true,
      canApproveCapabilities: false,
      canActivate: false,
      canPause: false,
      canRunNow: false,
      canPromoteCandidate: false,
    },
    ...overrides,
  };
}

const interfaces: LaunchInterfaceSummary[] = [
  {
    id: "inbox",
    label: "Inbox",
    description: "Review mail",
    functions: [],
    url: "/interface/inbox",
  },
  {
    id: "report",
    label: "Report",
    description: "Daily report",
    functions: [],
    url: "/interface/report",
  },
];

describe("operator Overview model", () => {
  it("hides all empty optional sections and keeps Directive", () => {
    expect(buildOperatorOverviewModel(home(), interfaces).sectionOrder)
      .toEqual(["directive"]);
  });

  it("uses the exact Attention count even when the bounded page is empty", () => {
    const model = buildOperatorOverviewModel(
      home({
        attention: {
          items: [],
          openCount: 241,
          requiresDecisionCount: 173,
          nextCursor: "attention-v1.next",
        },
      }),
      interfaces,
    );
    expect(model.attentionCount).toBe(241);
    expect(model.sectionOrder).toEqual(["attention", "directive"]);
  });

  it("uses the canonical populated-only order", () => {
    const model = buildOperatorOverviewModel(
      home({
        preferences: {
          agentId: "agent-1",
          favoriteInterfaceIds: ["report", "inbox"],
          favoritesInitialized: true,
          favoritesExplicit: true,
          revision: "preferences-v1",
          updatedAt: null,
        },
        attention: {
          items: [{
            id: "attention:one",
            notificationId: "one",
            agentId: "agent-1",
            type: "report",
            severity: "info",
            requiresAction: false,
            lifecycle: {
              state: "open",
              readAt: null,
              stateChangedAt: "2026-07-23T11:00:00.000Z",
              snoozedUntil: null,
              resolvedAt: null,
              resolutionReason: null,
              archivedAt: null,
            },
            brief: {
              headline: "Daily report",
              impact: null,
              context: null,
              recommendedNextMove: null,
              requiresDecision: false,
              confidence: null,
              evidence: [],
            },
            actions: [],
            occurredAt: "2026-07-23T11:00:00.000Z",
            enrichment: {
              status: "raw",
              version: null,
              generatedAt: null,
            },
            raw: {
              kind: "report",
              title: "Daily report",
              body: null,
            },
          }],
          openCount: 1,
          requiresDecisionCount: 0,
        },
        activity: {
          upNext: null,
          now: [],
          recent: [{
            id: "run:one",
            kind: "routine_run",
            phase: "recent",
            title: "Checked inbox",
            summary: null,
            status: "completed",
            occurredAt: "2026-07-23T10:00:00.000Z",
            scheduledAt: null,
            routineId: "routine-1",
            sourceId: "one",
            destination: null,
            evidence: [],
          }],
          items: [],
          generatedAt: "2026-07-23T12:00:00.000Z",
        },
        release: {
          live: null,
          candidate: {
            version: "1.1.0",
            uploadedAt: null,
            testedAt: null,
            sourceFingerprint: null,
            reviewStatus: "ready",
            canPromote: true,
            authorityChanges: [],
          },
          candidateCount: 1,
        },
      }),
      interfaces,
    );
    expect(model.sectionOrder).toEqual([
      "attention",
      "favorites",
      "directive",
      "activity",
      "signals",
    ]);
    expect(model.favoriteInterfaces.map((item) => item.id)).toEqual([
      "report",
      "inbox",
    ]);
  });

  it("drops stale favorite ids instead of rendering empty cards", () => {
    const model = buildOperatorOverviewModel(
      home({
        preferences: {
          agentId: "agent-1",
          favoriteInterfaceIds: ["removed"],
          favoritesInitialized: true,
          favoritesExplicit: true,
          revision: "preferences-v1",
          updatedAt: null,
        },
      }),
      interfaces,
    );
    expect(model.favoriteInterfaces).toEqual([]);
    expect(model.sectionOrder).toEqual(["directive"]);
  });
});
