import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LaunchAgentRoutineOverview,
  LaunchAgentRoutinesResponse,
} from "../../../../../shared/contracts/launch.ts";
import {
  AgentStudioRoutines,
  routineActionRequest,
  routineUpdateRequest,
} from "./agent-studio-routines";
import { retainIdempotencyKeyAfterFailure } from "../../lib/agent-studio-state";

function routine(
  overrides: Partial<LaunchAgentRoutineOverview> = {},
): LaunchAgentRoutineOverview {
  return {
    actions: {
      canActivate: false,
      canApproveCapabilities: false,
      canPause: true,
      canRunNow: true,
    },
    autoPauseReason: null,
    blockers: [],
    budgets: {
      maxCallsPerRun: 10,
      maxLightPerDay: 100,
      maxLightPerMonth: 1_000,
      maxLightPerRun: 20,
    },
    capabilities: [{
      access: "read",
      appId: "mail",
      appRef: "mail",
      approved: true,
      approvedAt: "2026-07-27T11:00:00.000Z",
      functionName: "check_inbox",
      id: "mail.check_inbox",
      purpose: "Read new messages.",
      required: true,
    }],
    description: "Read new messages and prepare safe follow-up work.",
    errorReason: null,
    failureCount: 0,
    health: "active",
    id: "routine-1",
    lastErrorAt: null,
    lastRunAt: "2026-07-27T12:00:00.000Z",
    lastSuccessAt: "2026-07-27T12:00:00.000Z",
    mission: "Keep the inbox moving.",
    name: "Check the inbox",
    nextOccurrences: ["2026-07-27T12:15:00.000Z"],
    nextRunAt: "2026-07-27T12:15:00.000Z",
    recentRuns: [],
    reportingDestination: {
      kind: "galactic_inbox",
      label: "Galactic inbox",
    },
    role: "primary",
    schedule: {
      intervalSeconds: 900,
      kind: "interval",
      label: "Every 15 minutes",
    },
    status: "active",
    ...overrides,
  };
}

function response(
  routines: LaunchAgentRoutineOverview[],
): LaunchAgentRoutinesResponse {
  return {
    agent: { id: "agent-1", name: "email-ops", slug: "email-ops" },
    aggregate: {
      active: routines.filter((item) => item.status === "active").length,
      failing: routines.filter((item) => item.health === "error").length,
      lastRunAt: null,
      nextRunAt: null,
      paused: routines.filter((item) => item.status === "paused").length,
      running: routines.filter((item) => item.health === "running").length,
      total: routines.length,
    },
    generatedAt: "2026-07-27T12:00:00.000Z",
    primaryRoutineId: routines.find((item) => item.role === "primary")?.id ??
      null,
    revision: "revision-7",
    routines,
  };
}

describe("Agent Studio Routines", () => {
  it("renders the release-backed cadence, calls, state, and edit affordance", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioRoutines
        agentIdOrSlug="email-ops"
        agentName="email-ops"
        onAddRoutine={() => undefined}
        onOpenRoutine={() => undefined}
        routines={response([routine()])}
      />,
    );

    expect(markup).toContain("When email-ops wakes up on its own.");
    expect(markup).toContain("Every 15 minutes");
    expect(markup).toContain("check_inbox");
    expect(markup).toContain("Primary");
    expect(markup).toContain('aria-label="Pause Check the inbox"');
    expect(markup).toContain("Run now");
  });

  it("keeps an empty collection truthful and routes creation to handoff", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioRoutines
        agentIdOrSlug="new-agent"
        agentName="new-agent"
        onAddRoutine={() => undefined}
        onOpenRoutine={() => undefined}
        routines={response([])}
      />,
    );

    expect(markup).toContain("No routines yet.");
    expect(markup).toContain("Use this");
    expect(markup).toContain("Adding a routine changes the Agent release.");
    expect(markup).not.toContain("Create routine now");
  });

  it("shows stale item deep links without opening another routine", () => {
    const markup = renderToStaticMarkup(
      <AgentStudioRoutines
        agentIdOrSlug="email-ops"
        agentName="email-ops"
        itemId="removed-routine"
        onAddRoutine={() => undefined}
        onOpenRoutine={() => undefined}
        routines={response([routine()])}
      />,
    );

    expect(markup).toContain(
      "This routine is no longer published by the live Agent.",
    );
    expect(markup).not.toContain('aria-label="Edit Check the inbox"');
  });

  it("binds every lifecycle action to the collection revision and retry key", () => {
    expect(
      routineActionRequest("revision-7", "run_now", "idempotency-1"),
    ).toEqual({
      action: "run_now",
      expectedRevision: "revision-7",
      idempotencyKey: "idempotency-1",
    });
    expect(retainIdempotencyKeyAfterFailure(new Error("network unknown"))).toBe(
      true,
    );
    expect(retainIdempotencyKeyAfterFailure({ status: 503 })).toBe(true);
    expect(retainIdempotencyKeyAfterFailure({
      code: "AGENT_HOME_ACTION_IN_PROGRESS",
      responseBody: { terminal: false },
      status: 409,
    })).toBe(true);
    expect(retainIdempotencyKeyAfterFailure({ status: 412 })).toBe(false);
  });

  it("normalizes routine edits into the existing managed-routine contract", () => {
    expect(
      routineUpdateRequest("revision-8", {
        description: "  ",
        expression: "",
        intervalMinutes: "0.25",
        kind: "interval",
        mission: " Triage ",
        name: " Inbox ",
        timezone: "",
      }),
    ).toEqual({
      description: null,
      expectedRevision: "revision-8",
      mission: "Triage",
      name: "Inbox",
      schedule: {
        intervalSeconds: 60,
        kind: "interval",
      },
    });
  });
});
