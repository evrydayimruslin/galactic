import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchAgentActivityItem,
  LaunchAgentActivityPreview,
} from "../../../../../shared/contracts/launch.ts";
import {
  activityFocusTargetId,
  AgentStudioActivity,
  AgentStudioContractBoundary,
  AgentStudioLimits,
  matchesActivityFilter,
  StudioRunSteps,
} from "./agent-studio-screens";
import type { LaunchOperatorRoutineRunDetail } from "../../../../../shared/contracts/launch.ts";

function runDetailFixture(): LaunchOperatorRoutineRunDetail {
  return {
    agent: { id: "agent-1", slug: "agent-1", name: "Agent One" },
    routine: { id: "routine-1", name: "Inbox loop", status: "active" },
    run: {
      id: "run-1",
      status: "completed",
      trigger: "schedule",
      traceId: null,
      startedAt: "2026-08-01T14:32:00.000Z",
      completedAt: "2026-08-01T14:32:04.200Z",
      durationMs: 4_200,
      usage: 3,
      summary: "Checked the inbox, drafted 2 replies, sent 1.",
    },
    diagnostic: null,
    steps: [
      {
        id: "step-1",
        stepIndex: 0,
        functionName: "check_inbox",
        status: "succeeded",
        durationMs: 820,
        usage: 1,
        receiptId: null,
        diagnostic: null,
        startedAt: null,
        completedAt: null,
      },
      {
        id: "step-2",
        stepIndex: 1,
        functionName: "galactic.ai",
        status: "succeeded",
        durationMs: 2_100,
        usage: 0,
        receiptId: null,
        diagnostic: null,
        startedAt: null,
        completedAt: null,
      },
      {
        id: "step-3",
        stepIndex: 2,
        functionName: "send_reply",
        status: "failed",
        durationMs: 610,
        usage: 1,
        receiptId: "receipt-3",
        diagnostic: {
          version: 1,
          code: "smtp_refused",
          causeCode: null,
          summary: "SMTP refused the send on the first attempt.",
          detail: null,
          provenance: "runtime",
          retryable: true,
        },
        startedAt: null,
        completedAt: null,
      },
    ],
    logReceipts: [{
      receiptId: "receipt-3",
      functionName: "send_reply",
      createdAt: "2026-08-01T14:32:04.000Z",
    }],
    generatedAt: "2026-08-01T14:32:05.000Z",
  } as unknown as LaunchOperatorRoutineRunDetail;
}

describe("Studio run steps (WO-3 thin slice)", () => {
  it("renders the ordered call table with durations, usage, and diagnostics", () => {
    const markup = renderToStaticMarkup(
      <StudioRunSteps detail={runDetailFixture()} />,
    );
    expect(markup).toContain("What it called, in order");
    expect(markup).toContain("check_inbox");
    // Flight-recorder AI exchanges render under the product name.
    expect(markup).toContain("ai.call");
    expect(markup).not.toContain("galactic.ai");
    expect(markup).toContain("820ms");
    expect(markup).toContain("2.1s");
    expect(markup).toContain("SMTP refused the send on the first attempt.");
    expect(markup).toContain("Checked the inbox, drafted 2 replies, sent 1.");
    expect(markup).toContain("1 log receipt");
    // The owner-safe projection has no argument/result content to leak.
    expect(markup).not.toContain("args");
  });

  it("says so plainly when a run recorded no calls", () => {
    const detail = { ...runDetailFixture(), steps: [] };
    const markup = renderToStaticMarkup(<StudioRunSteps detail={detail} />);
    expect(markup).toContain("No function calls were recorded for this run.");
  });
});

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

  it("marks the deep-linked run and resolves bare routine-run ids", () => {
    const items = [
      activityItem("run:run-14", "Morning triage"),
      activityItem("run:run-15", "Evening sweep"),
    ];
    // Search-index run links carry the bare run id; the item id also works.
    expect(activityFocusTargetId(items, "run-14")).toBe("run:run-14");
    expect(activityFocusTargetId(items, "run:run-15")).toBe("run:run-15");
    // Compute-run ids never appear in the feed → no focus, no crash.
    expect(activityFocusTargetId(items, "compute-run-9")).toBe(null);
    expect(activityFocusTargetId(items, undefined)).toBe(null);

    const activity = {
      generatedAt: "2026-07-27T12:00:00.000Z",
      items,
      now: [],
      recent: [],
      upNext: null,
    } as unknown as LaunchAgentActivityPreview;
    const markup = renderToStaticMarkup(
      <AgentStudioActivity
        activity={activity}
        hasMore={false}
        itemId="run-14"
        loading={false}
        onLoadMore={() => undefined}
      />,
    );
    expect(markup).toContain(
      'class="agent-studio-activity-run linked" id="agent-studio-activity-run:run-14"',
    );
    expect(markup).toContain(
      'class="agent-studio-activity-run" id="agent-studio-activity-run:run-15"',
    );
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

    expect(markup).toContain("32%");
    expect(markup).toContain("20% weekly ceiling");
    expect(markup).not.toContain(">5%<");
    expect(markup).toContain("Save ceiling");
  });
});
