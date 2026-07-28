import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchAgentActivityItem,
  LaunchAgentActivityPreview,
} from "../../../../../shared/contracts/launch.ts";
import {
  AgentStudioActivity,
  AgentStudioContractBoundary,
  AgentStudioLimits,
  matchesActivityFilter,
} from "./agent-studio-screens";

function activityItem(id: string, title: string): LaunchAgentActivityItem {
  return {
    destination: null,
    evidence: [],
    id,
    kind: "routine_run",
    occurredAt: "2026-07-27T12:00:00.000Z",
    phase: "recent",
    routineId: "routine-1",
    scheduledAt: null,
    sourceId: id,
    status: "succeeded",
    summary: null,
    title,
  };
}

describe("Agent Studio partial screens", () => {
  it("renders the bounded activity arrays if an older server omits items", () => {
    const activity = {
      generatedAt: "2026-07-27T12:00:00.000Z",
      now: [activityItem("now", "Running now")],
      recent: [activityItem("recent", "Finished recently")],
      upNext: activityItem("next", "Scheduled next"),
    } as unknown as LaunchAgentActivityPreview;
    const markup = renderToStaticMarkup(
      <AgentStudioActivity
        activity={activity}
        hasMore={false}
        loading={false}
        onLoadMore={() => undefined}
      />,
    );

    expect(markup).toContain("All <em>3</em>");
    expect(markup).toContain("Scheduled next");
    expect(markup).toContain("Running now");
    expect(markup).toContain("Finished recently");
  });

  it("renders the New-Agent first-run path without inventing a receipt", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioActivity
        activity={null}
        canRunNow
        hasMore={false}
        loading={false}
        newAgent
        onLoadMore={() => undefined}
        onRunNow={() => undefined}
      />,
    );

    expect(markup).toContain("The first run will leave a receipt here.");
    expect(markup).toContain("Run now");
  });

  it("states unsupported contracts without inventing product data", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioContractBoundary
        body="Use Interfaces today."
        description="Held work."
        details={["What prompted the held action"]}
        eyebrow="Not available for this Agent"
        heading="No Studio approvals are available yet."
        title="Approvals"
      />,
    );

    expect(markup).toContain("No Studio approvals are available yet.");
    expect(markup).toContain("Use Interfaces today.");
    expect(markup).toContain("What prompted the held action");
  });

  it("filters Activity by the semantics the filter labels promise", () => {
    expect(matchesActivityFilter(
      activityItem("run", "Run"),
      "needed_you",
    )).toBe(false);
    expect(matchesActivityFilter(
      {
        ...activityItem("release", "Release"),
        kind: "release",
      },
      "changed",
    )).toBe(true);
    expect(matchesActivityFilter(
      {
        ...activityItem("held", "Held"),
        status: "waiting_approval",
      },
      "needed_you",
    )).toBe(true);
    expect(matchesActivityFilter(
      activityItem("run", "Run"),
      "failed",
    )).toBe(false);
    expect(matchesActivityFilter(
      {
        ...activityItem("failed", "Failed"),
        status: "failed",
      },
      "failed",
    )).toBe(true);
  });

  it("keeps unavailable capacity distinct from a healthy 100% ceiling", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioLimits
        agentIdOrSlug="email-ops"
        capacity={undefined}
        onSaved={() => undefined}
      />,
    );

    expect(markup).toContain("unavailable");
    expect(markup).not.toContain("100%");
    expect(markup).not.toContain("Save ceiling");
  });

  it("uses cap consumption rather than account share for a capped Agent", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioLimits
        agentIdOrSlug="email-ops"
        capacity={{
          agentId: "agent-1",
          blocker: null,
          burst: {
            capUsedPercent: 41,
            resetsAt: "2026-07-27T17:00:00.000Z",
            shareUsedPercent: 7,
            state: "available",
          },
          capPercent: 20,
          generatedAt: "2026-07-27T12:00:00.000Z",
          nextEligibleAt: null,
          state: "available",
          weekly: {
            capUsedPercent: 32,
            resetsAt: "2026-08-01T00:00:00.000Z",
            shareUsedPercent: 5,
            state: "available",
          },
        }}
        onSaved={() => undefined}
      />,
    );

    expect(markup).toContain("41%");
    expect(markup).toContain("32% weekly");
    expect(markup).toContain("20% ceiling");
    expect(markup).not.toContain(">7%<");
    expect(markup).toContain("Save ceiling");
  });
});
